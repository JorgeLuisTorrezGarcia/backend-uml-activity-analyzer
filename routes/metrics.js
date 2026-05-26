import express from 'express';
import { prisma } from '../utils/prisma.js';
import { verifyToken } from '../utils/jwt.js';

const router = express.Router();

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Token inválido' });
  req.user = decoded;
  next();
};

/**
 * Obtener KPIs y métricas para el Dashboard de un Diagrama
 * GET /api/metrics/diagram/:diagramId
 */
router.get('/diagram/:diagramId', authenticate, async (req, res) => {
  try {
    const { diagramId } = req.params;

    const { startDate, endDate } = req.query;

    // 1. Instancias activas y completadas
    const allInstances = await prisma.executionInstance.findMany({
      where: { 
        diagramId,
        ...(startDate || endDate ? {
          startedAt: {
            ...(startDate ? { gte: new Date(startDate) } : {}),
            ...(endDate ? { lte: new Date(endDate) } : {}),
          }
        } : {})
      },
      include: {
        steps: { orderBy: { executedAt: 'asc' } }
      }
    });

    // Fetch diagram content to map names
    const diagram = await prisma.diagram.findUnique({
      where: { id: diagramId },
      select: { content: true }
    });

    const lanesMap = {};
    const nodesMap = {};
    if (diagram && diagram.content) {
      try {
        const content = typeof diagram.content === 'string' ? JSON.parse(diagram.content) : diagram.content;
        if (content.lanes) {
          content.lanes.forEach(l => {
            lanesMap[l.id] = l.title || l.id;
          });
        }
        if (content.nodes) {
          content.nodes.forEach(n => {
            nodesMap[n.id] = n.label || n.type || n.id;
          });
        }
      } catch (err) {
        console.error("Error parsing diagram content for names:", err);
      }
    }

    let activeProcesses = 0;
    let completedProcesses = 0;
    let totalCompletedTimeMs = 0;
    const uniqueUsers = new Set();
    
    // Análisis de Cuellos de Botella y Rendimiento por Área
    const nodeTimes = {}; // { nodeId: { totalMs: 0, count: 0, laneId: string } }
    const laneTimes = {}; // { laneId: { totalMs: 0, count: 0 } }

    allInstances.forEach(instance => {
      if (instance.status === 'RUNNING') activeProcesses++;
      if (instance.status === 'COMPLETED') {
        completedProcesses++;
        if (instance.endedAt) {
          totalCompletedTimeMs += (new Date(instance.endedAt).getTime() - new Date(instance.startedAt).getTime());
        }
      }

      uniqueUsers.add(instance.startedById);

      let lastTime = new Date(instance.startedAt).getTime();
      
      instance.steps.forEach(step => {
        uniqueUsers.add(step.userId);
        
        const currentMs = new Date(step.executedAt).getTime();
        const duration = currentMs - lastTime;
        lastTime = currentMs;

        // Registrar tiempo por Nodo
        if (!nodeTimes[step.nodeId]) {
          nodeTimes[step.nodeId] = { totalMs: 0, count: 0, laneId: step.laneId || 'Sin Área' };
        }
        nodeTimes[step.nodeId].totalMs += duration;
        nodeTimes[step.nodeId].count++;

        // Registrar tiempo por Área (Lane)
        const laneKey = step.laneId || 'Sin Área';
        if (!laneTimes[laneKey]) {
          laneTimes[laneKey] = { totalMs: 0, count: 0 };
        }
        laneTimes[laneKey].totalMs += duration;
        laneTimes[laneKey].count++;
      });
    });

    const averageTimeMs = completedProcesses > 0 ? totalCompletedTimeMs / completedProcesses : 0;

    // Formatear cuellos de botella (promedio por nodo)
    const bottlenecks = Object.entries(nodeTimes).map(([nodeId, data]) => ({
      nodeId,
      nodeLabel: nodesMap[nodeId] || nodeId,
      laneId: data.laneId,
      laneName: lanesMap[data.laneId] || data.laneId,
      averageTimeMs: data.totalMs / data.count,
      count: data.count
    })).sort((a, b) => b.averageTimeMs - a.averageTimeMs); // Ordenar de mayor a menor tiempo

    // Formatear rendimiento por área
    const performanceByLane = Object.entries(laneTimes).map(([laneId, data]) => ({
      laneId,
      laneName: lanesMap[laneId] || laneId,
      averageTimeMs: data.totalMs / data.count,
      totalInterventions: data.count
    }));

    res.json({
      activeProcesses,
      completedProcesses,
      averageTimeMs,
      activeUsers: uniqueUsers.size,
      bottlenecks: bottlenecks.slice(0, 10), // Top 10 cuellos de botella
      performanceByLane
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al calcular métricas' });
  }
});

export default router;
