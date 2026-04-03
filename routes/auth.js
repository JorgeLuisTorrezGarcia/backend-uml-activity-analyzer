import express from 'express';
import { register, login, getMe, updateSettings, getNotifications, markNotificationsRead } from '../controllers/auth.ctrl.js';
import { authMiddleware } from '../middlewares/auth.js';

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', authMiddleware, getMe);
router.put('/settings', authMiddleware, updateSettings);
router.get('/notifications', authMiddleware, getNotifications);
router.put('/notifications/read', authMiddleware, markNotificationsRead);

export default router;
