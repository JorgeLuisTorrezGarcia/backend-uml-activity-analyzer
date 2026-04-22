import express from 'express';
import { prisma } from '../utils/prisma.js';
import { verifyToken } from '../utils/jwt.js';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { generateReportAI } from '../controllers/ai.ctrl.js';

const router = express.Router();

// Configuración de almacenamiento Multer en Memoria para pipear a Cloudinary
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Configurar Cloudinary (toma variables de entorno automáticamente o manualmente)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MIDDLEWARE AUTENTICACIÓN
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Token inválido' });
  req.user = decoded;
  next();
};

/**
 * Iniciar una Instancia de Ejecución
 * POST /api/execute/instance
 */
router.post('/instance', authenticate, async (req, res) => {
  try {
    const { diagramId } = req.body;
    
    // Validar acceso (owner o colaborador)
    const diagram = await prisma.diagram.findUnique({
      where: { id: diagramId },
      include: { collaborators: true }
    });

    if (!diagram) {
      return res.status(404).json({ error: 'Diagrama no encontrado' });
    }

    const isOwner = diagram.ownerId === req.user.id;
    const isColab = diagram.collaborators.some(c => c.userId === req.user.id);
    if (!isOwner && !isColab) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const newInstance = await prisma.executionInstance.create({
      data: {
        diagramId,
        startedById: req.user.id,
        status: 'RUNNING'
      }
    });

    res.status(201).json(newInstance);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear la instancia BPM' });
  }
});

/**
 * Registrar un Paso de Ejecución y subir archivos a Cloudinary
 * POST /api/execute/step
 */
router.post('/step', authenticate, upload.array('files', 5), async (req, res) => {
  try {
    const { instanceId, nodeId, laneId, formData } = req.body;
    
    // Función auxiliar para subir a Cloudinary usando Streams (útil con memoryStorage)
    const uploadStream = (file) => {
      return new Promise((resolve, reject) => {
        // En caso de no tener configurado Cloudinary en el .env, evitamos que crashee
        if (!process.env.CLOUDINARY_CLOUD_NAME) {
          console.warn("CLOUDINARY no configurado, omitiendo subida y retornado faux-url");
          return resolve({ secure_url: `http://localhost:3001/fake-upload/${file.originalname}` });
        }
        
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'bpm_artifacts', resource_type: 'auto' },
          (error, result) => {
            if (result) {
              resolve(result);
            } else {
              reject(error);
            }
          }
        );
        stream.end(file.buffer);
      });
    };

    // Subir todos los archivos disparando las Promesas en Paralelo
    let artifactsUrls = [];
    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(file => uploadStream(file));
      const results = await Promise.all(uploadPromises);
      artifactsUrls = results.map(result => result.secure_url);
    }

    // VALIDACIÓN: Verificar si la instancia existe para evitar error de Llave Foránea (P2003)
    const instanceExists = await prisma.executionInstance.findUnique({
      where: { id: instanceId }
    });

    if (!instanceExists) {
      // Si la instancia no existe, significa que el token es local o la sesión expiró
      return res.status(400).json({ 
        error: 'Sesión de ejecución no encontrada en DB.', 
        suggestion: 'Por favor, detén la simulación y vuelve a "Lanzar Token" para iniciar una sesión persistente.' 
      });
    }

    const newStep = await prisma.executionStep.create({
      data: {
        instanceId,
        nodeId,
        laneId: laneId || null,
        userId: req.user.id,
        formData: formData ? JSON.parse(formData) : null,
        artifactsUrls
      }
    });

    res.status(201).json(newStep);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al registrar el token step o subir a nube' });
  }
});

/**
 * Finalizar Instancia de Ejecución
 * PUT /api/execute/instance/:id/complete
 */
router.put('/instance/:id/complete', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await prisma.executionInstance.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        endedAt: new Date()
      }
    });
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al finalizar instancia' });
  }
});

/**
 * Obtener historial de instancias por diagrama
 * GET /api/execute/diagram/:diagramId
 */
router.get('/diagram/:diagramId', authenticate, async (req, res) => {
  try {
    const { diagramId } = req.params;
    const instances = await prisma.executionInstance.findMany({
      where: { diagramId },
      include: {
        startedBy: { select: { name: true, email: true } },
        _count: { select: { steps: true } }
      },
      orderBy: { startedAt: 'desc' }
    });
    res.json(instances);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo instancias' });
  }
});

/**
 * Obtener timeline (steps) de una instancia específica
 * GET /api/execute/instance/:id
 */
router.get('/instance/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const instance = await prisma.executionInstance.findUnique({
      where: { id },
      include: {
        startedBy: { select: { name: true, email: true } },
        steps: {
          orderBy: { executedAt: 'asc' },
          include: {
            executedBy: { select: { name: true, email: true } }
          }
        }
      }
    });
    if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
    res.json(instance);
  } catch (error) {
    res.status(500).json({ error: 'Error cargando historial del ticket' });
  }
});

/**
 * Obtener el historial enfocado de ejecuciones pasadas para UN SOLO nodo
 * GET /api/execute/diagram/:diagramId/node/:nodeId
 */
router.get('/diagram/:diagramId/node/:nodeId', authenticate, async (req, res) => {
  try {
    const { diagramId, nodeId } = req.params;
    
    // Buscar todos los steps de instancias que pertenecen a este diagrama que coincidan con el nodo
    const history = await prisma.executionStep.findMany({
      where: {
        nodeId: nodeId,
        instance: { diagramId: diagramId }
      },
      include: {
        executedBy: { select: { name: true, email: true } },
        instance: { select: { startedBy: { select: { name: true } } } }
      },
      orderBy: { executedAt: 'desc' },
      take: 20 // Limitar últimos 20 registros
    });

    res.json(history);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error obteniendo historial de nodo' });
  }
});

/**
 * Obtener todas las instancias de ejecución (historial global) de un diagrama
 * GET /api/execute/diagram/:diagramId/instances
 */
router.get('/diagram/:diagramId/instances', authenticate, async (req, res) => {
  try {
    const { diagramId } = req.params;
    const instances = await prisma.executionInstance.findMany({
      where: { diagramId: diagramId },
      include: {
        startedBy: { select: { name: true, email: true } },
        steps: { select: { id: true } } // Para saber cuántos pasos tuvo
      },
      orderBy: { startedAt: 'desc' },
      take: 50
    });
    res.json(instances);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error obteniendo instancias globales' });
  }
});

/**
 * Generar Reporte de Auditoría con IA para una instancia
 * POST /api/execute/instance/:instanceId/ai-report
 */
router.post('/instance/:instanceId/ai-report', authenticate, generateReportAI);

export default router;
