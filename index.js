import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import diagramRoutes from './routes/diagrams.js';
import aiRoutes from './routes/ai.js';
import { verifyToken } from './utils/jwt.js';
import { prisma } from './utils/prisma.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ── Rutas REST API ──────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/diagrams', diagramRoutes);
app.use('/api/ai', aiRoutes);

// ── Sockets Sincronización en Tiempo Real ───────
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Middleware Global de Autenticación para WebSockets
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error("Acceso denegado: Token ausente en socket handshake"));
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return next(new Error("Acceso denegado: Token de socket inválido o expirado"));
  }
  
  socket.user = decoded; // Adjuntar el payload de la sesión al socket
  next();
});

io.on('connection', (socket) => {
  console.log(`User ${socket.user.name} connected via socket:`, socket.id);

  socket.on('join-room', async (roomId) => {
    // 1. Validar Permisos del Usuario respecto al Diagrama
    try {
      const diagram = await prisma.diagram.findUnique({
        where: { id: roomId },
        include: { collaborators: true }
      });

      if (!diagram) {
        socket.emit('error', 'El diagrama no existe');
        return;
      }

      const isOwner = diagram.ownerId === socket.user.id;
      const colab = diagram.collaborators.find(c => c.userId === socket.user.id);
      
      if (!isOwner && !colab) {
        socket.emit('error', 'No tienes permisos para acceder a este diagrama');
        return;
      }

      // Conceder ingreso a la sala de Socket.io
      socket.join(roomId);
      console.log(`User ${socket.user.name} joined diagram: ${roomId}`);
      
      // Adjuntamos los roles de este socket activo
      socket.diagramRole = {
        isOwner,
        canEdit: isOwner || colab?.canEdit,
        canSave: isOwner || colab?.canSave,
        canDelete: isOwner || colab?.canDelete
      };

      // Emitir el estado más reciente extraído de PostgreSQL
      socket.emit('initial-state', diagram.content);
      
    } catch (err) {
      console.error(err);
      socket.emit('error', 'Error al unirse al diagrama');
    }
  });

  socket.on('update-state', async ({ roomId, state }) => {
    if (!socket.diagramRole?.canEdit) {
      socket.emit('error', 'Solo lectura: No tienes permisos para editar este diagrama');
      return;
    }

    try {
      // Broadcast rápido al resto
      socket.to(roomId).emit('state-updated', state);

      // Persistencia en Batch. Node.js lo ejecutará de forma asíncrona pero sin bloquear la UI
      // Nota: En un entorno de alto tráfico, conviene recolectar y ejecutar de forma cronometrada
      // Pero por ahora en MVP actualizamos directo a BD en cada cambio importante (ideal para el Save)
      // Si el cliente emite frenéticamente, conviene que el 'update-state' solo ocurra al soltar el drag.
      
      await prisma.diagram.update({
        where: { id: roomId },
        data: { content: state }
      });
    } catch (e) {
      // Ignorar rebotes transitorios
    }
  });

  socket.on('node-moved', ({ roomId, id, x, y }) => {
    if (!socket.diagramRole?.canEdit) return;
    
    // Solo enviamos el broacast de render visual.  
    // La persistencia oficial a BD de esto vendrá cuando se emita update-state
    socket.to(roomId).emit('node-moved', { id, x, y });
  });

  socket.on('cursor-move', ({ roomId, cursor }) => {
    socket.to(roomId).emit('cursor-moved', { userId: socket.user.name, cursor });
  });

  socket.on('disconnect', () => {
    console.log(`User ${socket.user?.name} disconnected`);
    io.emit('user-left', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Backend SaaS & Socket.io server running on port ${PORT}`);
});
