import express from 'express';
import { generateDiagramAI, predictExecutionTime } from '../controllers/ai.ctrl.js';
import { authMiddleware } from '../middlewares/auth.js';

const router = express.Router();

router.use(authMiddleware);
router.post('/generate', generateDiagramAI);
router.post('/predict-instance', predictExecutionTime);

export default router;
