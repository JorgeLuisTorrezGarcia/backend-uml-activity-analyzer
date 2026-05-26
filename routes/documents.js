import express from 'express';
import { prisma } from '../utils/prisma.js';
import { verifyToken } from '../utils/jwt.js';
import { signS3Url } from '../utils/s3signer.js';
import multer from 'multer';
import { S3Client } from '@aws-sdk/client-s3';
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

export default router;
