import express from 'express';
import { getMyDiagrams, createDiagram, updateDiagram, deleteDiagram, inviteCollaborator } from '../controllers/diagrams.ctrl.js';
import { authMiddleware } from '../middlewares/auth.js';

const router = express.Router();

router.use(authMiddleware);

router.get('/', getMyDiagrams);
router.post('/', createDiagram);
router.put('/:id', updateDiagram);
router.delete('/:id', deleteDiagram);
router.post('/:diagramId/invite', inviteCollaborator);

export default router;
