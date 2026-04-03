import { prisma } from '../utils/prisma.js';
import { v4 as uuidv4 } from 'uuid';

// Crear Diagrama Inicial
const getEmptyState = () => ({
  lanes: [
    { id: 'lane-1', title: 'Cliente', color: '#3b82f6', order: 0, width: 280 },
    { id: 'lane-2', title: 'Sistema', color: '#10b981', order: 1, width: 280 }
  ],
  nodes: [],
  arrows: []
});

export const getMyDiagrams = async (req, res) => {
  try {
    const userId = req.user.id;

    // Obtener los propios
    const owned = await prisma.diagram.findMany({
      where: { ownerId: userId },
      orderBy: { updatedAt: 'desc' }
    });

    // Obtener en los que es invitado
    const collaborations = await prisma.diagramCollaborator.findMany({
      where: { userId },
      include: {
        diagram: { include: { owner: { select: { name: true, email: true } } } }
      }
    });

    res.json({
      owned,
      sharedWithMe: collaborations.map(c => ({
        ...c.diagram,
        role: c.canEdit ? 'Editor' : 'Lector',
        permissions: { canEdit: c.canEdit, canSave: c.canSave, canDelete: c.canDelete }
      }))
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error obteniendo diagramas' });
  }
};

export const createDiagram = async (req, res) => {
  try {
    const { name } = req.body;
    const finalName = name || 'Nuevo Diagrama';
    
    // Generar el payload base del diagrama inicial vacío
    const content = {
      id: uuidv4(),
      name: finalName,
      ...getEmptyState()
    };

    const diagram = await prisma.diagram.create({
      data: {
        name: finalName,
        content: content,
        ownerId: req.user.id
      }
    });

    res.status(201).json(diagram);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error creando diagrama' });
  }
};

export const deleteDiagram = async (req, res) => {
  try {
    const { id } = req.params;
    const diagram = await prisma.diagram.findUnique({ where: { id } });

    if (!diagram) return res.status(404).json({ error: 'No encontrado' });

    if (diagram.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Solo el dueño puede eliminar' });
    }

    await prisma.diagram.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error eliminando diagrama' });
  }
};

export const updateDiagram = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, content } = req.body;

    const diagram = await prisma.diagram.findUnique({ 
      where: { id },
      include: { collaborators: true }
    });

    if (!diagram) return res.status(404).json({ error: 'No encontrado' });

    const isOwner = diagram.ownerId === req.user.id;
    const colab = diagram.collaborators.find(c => c.userId === req.user.id);
    const canSave = isOwner || colab?.canSave;

    if (!canSave) {
      return res.status(403).json({ error: 'No tienes permisos para guardar cambios en este diagrama' });
    }

    const updated = await prisma.diagram.update({
      where: { id },
      data: { 
        name: name || diagram.name,
        content: content || diagram.content
      }
    });

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar diagrama' });
  }
};

export const inviteCollaborator = async (req, res) => {
  try {
    const { diagramId } = req.params;
    const { email, canEdit, canSave, canDelete } = req.body;

    const diagram = await prisma.diagram.findUnique({ where: { id: diagramId } });
    if (!diagram) return res.status(404).json({ error: 'Diagrama no encontrado' });

    if (diagram.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Solo el dueño puede invitar' });
    }

    const targetUser = await prisma.user.findUnique({ where: { email } });
    if (!targetUser) {
      return res.status(404).json({ error: 'Usuario a invitar no registrado' });
    }

    if (targetUser.id === diagram.ownerId) {
      return res.status(400).json({ error: 'El dueño ya tiene acceso total' });
    }

    // Upsert colaborador
    const colab = await prisma.diagramCollaborator.upsert({
      where: {
        diagramId_userId: { diagramId, userId: targetUser.id }
      },
      update: { canEdit, canSave, canDelete },
      create: { diagramId, userId: targetUser.id, canEdit, canSave, canDelete }
    });

    // Crear notificacion In-App
    await prisma.notification.create({
      data: {
        userId: targetUser.id,
        message: `${req.user.name || 'Un usuario'} te ha invitado a colaborar en el diagrama '${diagram.name}'`
      }
    });

    res.json(colab);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al invitar colaborador' });
  }
};
