import express from 'express';
import { prisma } from '../utils/prisma.js';
import { verifyToken } from '../utils/jwt.js';
import { signS3Url } from '../utils/s3signer.js';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import HTMLtoDOCX from 'html-to-docx';
import fs from 'fs';
import path from 'path';
import multerS3 from 'multer-s3';

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
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      cb(null, `bpm_artifacts/${Date.now().toString()}_${file.originalname}`);
    }
  });
} else {
  storage = multer.memoryStorage();
}

const upload = multer({ storage: storage });

const router = express.Router();

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Token inválido' });
  req.user = decoded;
  next();
};
import axios from 'axios';

/**
 * Endpoint proxy para descargar de S3 y servir con Content-Type correcto y bypasear CORS
 * GET /api/documents/proxy?url=...
 */
router.get('/proxy', authenticate, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL missing');
    
    const response = await axios.get(url, { responseType: 'stream' });
    
    // Guess content-type
    const ext = url.split('?')[0].split('.').pop().toLowerCase();
    const mimeTypes = {
       'pdf': 'application/pdf',
       'png': 'image/png',
       'jpg': 'image/jpeg',
       'jpeg': 'image/jpeg',
       'gif': 'image/gif',
       'webp': 'image/webp',
       'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
       'doc': 'application/msword'
    };
    if (mimeTypes[ext]) {
      res.setHeader('Content-Type', mimeTypes[ext]);
    } else {
      res.setHeader('Content-Type', response.headers['content-type']);
    }
    
    res.setHeader('Content-Disposition', 'inline');
    response.data.pipe(res);
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).send('Error proxying document');
  }
});
/**
 * Obtener todos los documentos de un diagrama, con su historial de versiones
 * GET /api/documents/diagram/:diagramId
 */
router.get('/diagram/:diagramId', authenticate, async (req, res) => {
  try {
    const { diagramId } = req.params;
    
    const documents = await prisma.document.findMany({
      where: { diagramId },
      include: {
        versions: {
          include: {
            uploadedBy: { select: { name: true, email: true } },
            step: { select: { executedAt: true, instanceId: true } }
          },
          orderBy: { versionNumber: 'desc' }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Pre-firmar las URLs de S3
    const signedDocuments = await Promise.all(documents.map(async (doc) => {
      const signedVersions = await Promise.all(doc.versions.map(async (version) => {
        const signedUrl = await signS3Url(version.url);
        return { ...version, url: signedUrl };
      }));
      return { ...doc, versions: signedVersions };
    }));

    res.json(signedDocuments);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener repositorio de documentos' });
  }
});

/**
 * Subir una nueva versión a un documento existente
 * POST /api/documents/:documentId/version
 */
router.post('/:documentId/version', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { documentId } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No se envió archivo' });
    }

    const document = await prisma.document.findUnique({
      where: { id: documentId },
    });

    if (!document) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    const lastVersion = await prisma.documentVersion.findFirst({
      where: { documentId: document.id },
      orderBy: { versionNumber: 'desc' }
    });
    
    const nextVersion = (lastVersion?.versionNumber || 0) + 1;
    const fileUrl = file.location || `http://localhost:3001/fake-upload/${file.originalname}`;

    const newVersion = await prisma.documentVersion.create({
      data: {
        documentId: document.id,
        url: fileUrl,
        versionNumber: nextVersion,
        uploadedById: req.user.id
      }
    });

    res.status(201).json(newVersion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al subir nueva versión' });
  }
});

/**
 * Actualizar el estado de revisión de una versión del documento
 * PUT /api/documents/version/:versionId/status
 */
router.put('/version/:versionId/status', authenticate, async (req, res) => {
  try {
    const { versionId } = req.params;
    const { status } = req.body;

    if (!['EN_REVISION', 'ACEPTADO', 'RECHAZADO'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const version = await prisma.documentVersion.findUnique({
      where: { id: versionId },
      include: {
        document: { select: { diagramId: true } }
      }
    });

    if (!version) {
      return res.status(404).json({ error: 'Versión de documento no encontrada' });
    }

    const updatedVersion = await prisma.documentVersion.update({
      where: { id: versionId },
      data: {
        status,
        reviewedById: req.user.id,
        reviewedAt: new Date()
      },
      include: {
        uploadedBy: { select: { name: true, email: true } },
        reviewedBy: { select: { name: true, email: true } }
      }
    });

    // Emitir por socket para tiempo real si está configurado
    const io = req.app.get('io');
    if (io) {
      io.to(version.document.diagramId).emit('document-status-updated', {
        versionId,
        status,
        reviewedBy: updatedVersion.reviewedBy,
        reviewedAt: updatedVersion.reviewedAt
      });
    }

    res.json(updatedVersion);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar estado de la versión' });
  }
});

/**
 * Guardar una nueva versión de un documento a partir de contenido HTML (editor enriquecido)
 * POST /api/documents/:documentId/version-html
 */
router.post('/:documentId/version-html', authenticate, async (req, res) => {
  try {
    const { documentId } = req.params;
    const { contentHtml, docName } = req.body;

    if (!contentHtml) {
      return res.status(400).json({ error: 'Contenido HTML requerido' });
    }

    const document = await prisma.document.findUnique({
      where: { id: documentId },
    });

    if (!document) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    // Convertir el HTML a un buffer DOCX nativo usando html-to-docx (compatible con Google Docs, etc.)
    const fullHtml = contentHtml.includes('<html') 
      ? contentHtml 
      : `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${contentHtml}</body></html>`;

    const docxBuffer = await HTMLtoDOCX(fullHtml, null, {
      orientation: 'portrait',
      pageSize: 'A4',
      margins: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
    });

    let fileUrl = '';
    const safeDocName = docName || document.name;

    if (process.env.AWS_BUCKET_NAME) {
      const s3Client = new S3Client({
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      });

      const uniqueKey = `bpm_artifacts/${Date.now().toString()}_${safeDocName}`;
      const uploadParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: uniqueKey,
        Body: docxBuffer,
        ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };

      await s3Client.send(new PutObjectCommand(uploadParams));
      fileUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${uniqueKey}`;
    } else {
      const uniqueName = `${Date.now()}_${safeDocName}`;
      const uploadsDir = path.resolve('uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      fs.writeFileSync(path.join(uploadsDir, uniqueName), docxBuffer);
      fileUrl = `http://localhost:3001/uploads/${uniqueName}`;
    }

    const lastVersion = await prisma.documentVersion.findFirst({
      where: { documentId: document.id },
      orderBy: { versionNumber: 'desc' }
    });
    
    const nextVersion = (lastVersion?.versionNumber || 0) + 1;

    const newVersion = await prisma.documentVersion.create({
      data: {
        documentId: document.id,
        url: fileUrl,
        versionNumber: nextVersion,
        uploadedById: req.user.id
      },
      include: {
        uploadedBy: { select: { name: true, email: true } }
      }
    });

    res.status(201).json(newVersion);
  } catch (error) {
    console.error('Error al generar DOCX desde HTML:', error);
    res.status(500).json({ error: 'Error al generar o guardar el documento DOCX' });
  }
});

export default router;
