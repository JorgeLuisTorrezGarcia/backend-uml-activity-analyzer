import express from 'express';
import { generateDiagramAI } from '../controllers/ai.ctrl.js';
import { authMiddleware } from '../middlewares/auth.js';

const router = express.Router();

router.use(authMiddleware);
router.post('/generate', generateDiagramAI);

export default router;
