import bcrypt from 'bcrypt';
import { prisma } from '../utils/prisma.js';
import { generateToken } from '../utils/jwt.js';

export const register = async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'El email ya está en uso' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
      },
    });

    const token = generateToken(user);
    
    // Devolvemos el usuario sin el hash
    const { passwordHash: _, ...userSafe } = user;
    res.status(201).json({ token, user: userSafe });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error del servidor al registrar usuario' });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = generateToken(user);
    
    const { passwordHash: _, ...userSafe } = user;
    res.json({ token, user: userSafe });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error del servidor al iniciar sesión' });
  }
};

export const getMe = async (req, res) => {
  // Ya pasó por el middleware
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, name: true, geminiApiKey: true }
  });
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  
  const hasGeminiKey = !!user.geminiApiKey;
  delete user.geminiApiKey;
  
  res.json({ ...user, hasGeminiKey });
};

export const updateSettings = async (req, res) => {
  try {
    const { geminiApiKey } = req.body;
    let encryptedKey = null;
    
    if (geminiApiKey) {
      const { encrypt } = await import('../utils/crypto.js');
      encryptedKey = encrypt(geminiApiKey);
    }
    
    await prisma.user.update({
      where: { id: req.user.id },
      data: { geminiApiKey: encryptedKey }
    });
    
    res.json({ success: true, hasGeminiKey: !!geminiApiKey });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error guardando configuracion' });
  }
};

export const getNotifications = async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: 'Error cargando notificaciones' });
  }
};

export const markNotificationsRead = async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error actualizando notificaciones' });
  }
};
