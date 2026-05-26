import express from 'express';
import { prisma } from '../utils/prisma.js';
import { verifyToken } from '../utils/jwt.js';
import multer from 'multer';
import { S3Client } from '@aws-sdk/client-s3';
import multerS3 from 'multer-s3';
import { generateReportAI } from '../controllers/ai.ctrl.js';
import { signS3Url } from '../utils/s3signer.js';

const router = express.Router();

let storage;
if (process.env.AWS_BUCKET_NAME) {
  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
  });
  storage = multerS3({
    s3: s3,
    bucket: process.env.AWS_BUCKET_NAME,
    metadata: function (req, file, cb) {
      cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
      cb(null, `bpm_artifacts/${Date.now().toString()}_${file.originalname}`);
    }
  });
} else {
  // Fallback si no hay S3 configurado
  storage = multer.memoryStorage();
}

const upload = multer({ storage: storage });

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
    const { diagramId, activeTokens } = req.body;
    
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
        status: 'RUNNING',
        activeTokens: activeTokens ? JSON.parse(activeTokens) : null
      }
    });

    // Notificar a otros si se inicia una instancia compartida
    if (req.app.get('io') && activeTokens) {
      req.app.get('io').to(diagramId).emit('instance_started', {
        instanceId: newInstance.id,
        activeTokens: JSON.parse(activeTokens)
      });
    }

    res.status(201).json(newInstance);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear la instancia BPM' });
  }
});

/**
 * Registrar un Paso de Ejecución y subir archivos a S3
 * POST /api/execute/step
 */
router.post('/step', authenticate, upload.array('files', 5), async (req, res) => {
  try {
    const { instanceId, nodeId, laneId, formData } = req.body;

    // VALIDACIÓN: Verificar si la instancia existe
    const instanceExists = await prisma.executionInstance.findUnique({
      where: { id: instanceId }
    });

    if (!instanceExists) {
      return res.status(400).json({ 
        error: 'Sesión de ejecución no encontrada en DB.', 
        suggestion: 'Por favor, detén la simulación y vuelve a "Lanzar Token" para iniciar una sesión persistente.' 
      });
    }

    // Recolectar URLs de S3 (o fake URLs en memoryStorage fallback)
    const artifactsUrls = req.files ? req.files.map(file => file.location || `http://localhost:3001/fake-upload/${file.originalname}`) : [];

    // 1. Crear el Step de Ejecución (Paso BPM)
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

    // 1.5 Actualizar activeTokens de la instancia
    const activeTokensRaw = req.body.activeTokens;
    if (activeTokensRaw) {
      await prisma.executionInstance.update({
        where: { id: instanceId },
        data: { activeTokens: JSON.parse(activeTokensRaw) }
      });
      
      // Emitir evento WebSocket si está configurado (global via req.app)
      if (req.app.get('io')) {
        req.app.get('io').to(instanceExists.diagramId).emit('instance_updated', {
          instanceId: instanceId,
          activeTokens: JSON.parse(activeTokensRaw)
        });
      }
    }

    // 2. Lógica del Repositorio de Documentos (S3)
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileUrl = file.location || `http://localhost:3001/fake-upload/${file.originalname}`;
        
        let document = await prisma.document.findUnique({
           where: { diagramId_name: { diagramId: instanceExists.diagramId, name: file.originalname } }
        });
        
        let nextVersion = 1;
        if (!document) {
           document = await prisma.document.create({
              data: {
                 name: file.originalname,
                 diagramId: instanceExists.diagramId
              }
           });
        } else {
           const lastVersion = await prisma.documentVersion.findFirst({
              where: { documentId: document.id },
              orderBy: { versionNumber: 'desc' }
           });
           nextVersion = (lastVersion?.versionNumber || 0) + 1;
        }
        
        await prisma.documentVersion.create({
           data: {
              documentId: document.id,
              url: fileUrl,
              versionNumber: nextVersion,
              uploadedById: req.user.id,
              stepId: newStep.id
           }
        });
      }
    }

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
 * Obtener instancias de ejecución activas para un diagrama (Collaborative Engine)
 * GET /api/execute/diagram/:diagramId/active
 */
router.get('/diagram/:diagramId/active', authenticate, async (req, res) => {
  try {
    const { diagramId } = req.params;
    const instances = await prisma.executionInstance.findMany({
      where: { 
        diagramId: diagramId,
        status: 'RUNNING'
      },
      include: {
        startedBy: { select: { name: true, email: true } }
      },
      orderBy: { startedAt: 'desc' }
    });
    res.json(instances);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error obteniendo instancias activas' });
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

    // Pre-firmar las URLs de los artefactos
    const signedHistory = await Promise.all(history.map(async (step) => {
      if (step.artifactsUrls && step.artifactsUrls.length > 0) {
        const signedUrls = await Promise.all(step.artifactsUrls.map(url => signS3Url(url)));
        return { ...step, artifactsUrls: signedUrls };
      }
      return step;
    }));

    res.json(signedHistory);
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

/**
 * BACKLOG / AUDIT LOG COMPLETO (sin IA)
 * GET /api/execute/diagram/:diagramId/audit-log
 * Devuelve TODA la información consolidada de un diagrama:
 * - Datos del Diagrama (nombre, propietario, fecha)
 * - Colaboradores
 * - Ejecuciones (instancias + todos sus pasos)
 * - Documentos (nombre, versiones, URLs firmadas)
 */
router.get('/diagram/:diagramId/audit-log', authenticate, async (req, res) => {
  try {
    const { diagramId } = req.params;

    // 1. Datos del diagrama + propietario + colaboradores
    const diagram = await prisma.diagram.findUnique({
      where: { id: diagramId },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        collaborators: {
          include: {
            user: { select: { id: true, name: true, email: true } }
          }
        }
      }
    });

    if (!diagram) {
      return res.status(404).json({ error: 'Diagrama no encontrado' });
    }

    // 2. Todas las instancias de ejecución con sus pasos completos
    const instances = await prisma.executionInstance.findMany({
      where: { diagramId },
      include: {
        startedBy: { select: { name: true, email: true } },
        steps: {
          orderBy: { executedAt: 'asc' },
          include: {
            executedBy: { select: { name: true, email: true } }
          }
        }
      },
      orderBy: { startedAt: 'desc' }
    });

    // Pre-firmar las URLs de los artefactos en los steps
    for (const inst of instances) {
      for (const step of inst.steps) {
        if (step.artifactsUrls && step.artifactsUrls.length > 0) {
          step.artifactsUrls = await Promise.all(step.artifactsUrls.map(url => signS3Url(url)));
        }
      }
    }

    // 3. Todos los documentos del diagrama con sus versiones
    const documents = await prisma.document.findMany({
      where: { diagramId },
      include: {
        versions: {
          include: {
            uploadedBy: { select: { name: true, email: true } }
          },
          orderBy: { versionNumber: 'desc' }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Pre-firmar las URLs de los documentos
    for (const doc of documents) {
      for (const v of doc.versions) {
        v.url = await signS3Url(v.url);
      }
    }

    // 4. Responder con toda la información consolidada
    res.json({
      diagram: {
        id: diagram.id,
        name: diagram.name,
        createdAt: diagram.createdAt,
        updatedAt: diagram.updatedAt,
        owner: diagram.owner,
        collaborators: diagram.collaborators.map(c => ({
          name: c.user.name,
          email: c.user.email,
          canEdit: c.canEdit,
          canSave: c.canSave,
          canDelete: c.canDelete
        }))
      },
      instances,
      documents
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error obteniendo audit-log completo' });
  }
});

export default router;

