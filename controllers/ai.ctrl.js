import { GoogleGenAI } from '@google/genai';
import { prisma } from '../utils/prisma.js';
import { decrypt } from '../utils/crypto.js';

export const generateDiagramAI = async (req, res) => {
  try {
    const { prompt, currentDiagram } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'El prompt es obligatorio' });
    }

    // 1. Obtener la llave del usuario
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { geminiApiKey: true }
    });

    if (!user || !user.geminiApiKey) {
      return res.status(403).json({ error: 'Debes configurar tu API Key de Gemini en Configuración primero.' });
    }

    const apiKey = decrypt(user.geminiApiKey);
    const ai = new GoogleGenAI({ apiKey });

    // 2. Definir el Sistema
    const systemInstruction = `
      Eres un arquitecto experto en Diagramas de Actividad UML (React Konva Json). 
      Se te pasará el JSON actual del diagrama delimitado por ###, y el usuario pedirá un cambio.
      Deberás retornar EXCLUSIVAMENTE el nuevo JSON DiagramState completo y mutado, listo para hacer setState. NO devuelvas texto markdown ni explicaciones, solo el JSON puro.
      
      Reglas del JSON:
      - interface DiagramNode { id:string, type:'activity'|'start'|'end'|'decision'|'fork'|'join', laneId:string, x:number, y:number, width:number, height:number, label:string, color?:string }
      - interface SwimLane { id:string, title:string, color:string, order:number, width:number }
      - interface DiagramArrow { id:string, fromId:string, toId:string, fromPort:'top'|'bottom'|'left'|'right', toPort:'top'|'bottom'|'left'|'right', waypoints:Array }
      - Interface Central: { id, name, lanes: SwimLane[], nodes: DiagramNode[], arrows: DiagramArrow[] }
      - Si el prompt es "Crear un diagrama estructurado de login", genera los SwimLanes (Sistema, Cliente) y los nodos start, activities y end conectados.
      - Para las dimensiones x, y, genéralas en ubicaciones matemáticas (ej: x: 120, y: 150) teniendo en cuenta que el lane-1 empieza en x=80 y el lane-2 en x=360 (con un ancho constante de 280 para los lanes). Las flechas deben enlazar correctamente los IDs.
    `;

    const userPrompt = `
      ### DIAGRAMA ACTUAL
      ${JSON.stringify(currentDiagram || { lanes: [], nodes: [], arrows: [] })}
      ###
      
      Instrucción del usuario: "${prompt}"
    `;

    // 3. Llamada al LLM usando la gema nueva
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.2, // Baja temperatura para mantener JSON estricto
      }
    });

    const outputString = response.text;
    
    // Extraer JSON si el modelo lo envolvió en markdown
    let jsonStr = outputString;
    const match = outputString.match(/```(?:json)?([\s\S]*?)```/);
    if (match) {
      jsonStr = match[1].trim();
    }

    const newDiagramState = JSON.parse(jsonStr);

    res.json(newDiagramState);
  } catch (error) {
    console.error("AI Gen Error:", error);
    res.status(500).json({ error: error.message || 'Error comunicándose con Gemini.' });
  }
};

export const generateReportAI = async (req, res) => {
  try {
    const { instanceId } = req.params;

    // 1. Obtener la llave del usuario
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { geminiApiKey: true }
    });

    if (!user || !user.geminiApiKey) {
      return res.status(403).json({ error: 'Debes configurar tu API Key de Gemini en Configuración primero.' });
    }

    // 2. Obtener la instancia, el diagrama y los pasos
    const instance = await prisma.executionInstance.findUnique({
      where: { id: instanceId },
      include: {
        startedBy: { select: { name: true, email: true } },
        diagram: { select: { name: true, content: true } },
        steps: {
          orderBy: { executedAt: 'asc' },
          include: { executedBy: { select: { name: true } } }
        }
      }
    });

    if (!instance) {
      return res.status(404).json({ error: 'Instancia no encontrada' });
    }

    const apiKey = decrypt(user.geminiApiKey);
    const ai = new GoogleGenAI({ apiKey });

    // 3. Sistema para Reportes
    const systemInstruction = `
      Eres un Auditor Corporativo Senior experto en análisis de procesos de negocio (BPM).
      El usuario te pasará un registro JSON de la ejecución de un workflow.
      Tu trabajo es redactar un INFORME EJECUTIVO PROFESIONAL EN MARKDOWN.
      Debe contener:
      1. Título y Resumen Ejecutivo (¿Qué proceso fue, cuándo inició, cuánto tardó en general?)
      2. Línea de Tiempo (Mapeo de quién hizo qué nodo, marcando horas)
      3. Análisis de Datos (Haz un resumen amigable de los "formData" recopilados en los pasos, destacando decisiones o campos clave).
      4. Observaciones/Cuellos de Botella (Si notas que pasó mucho tiempo entre un paso y otro, menciónalo).

      REGLA ESTRICTA: Tu respuesta debe ser SOLO texto en Markdown válido. No incluyas \`\`\`markdown al inicio, redacta directo el contenido. Usa tablas si es útil para los datos.
    `;

    const userPrompt = `
      ### DATOS DE EJECUCIÓN (BPM)
      - Diagrama: ${instance.diagram.name}
      - Iniciado por: ${instance.startedBy.name}
      - Fecha Inicio: ${instance.startedAt}
      - Fecha Fin: ${instance.endedAt || 'En curso'}
      
      ### PASOS (HISTORIAL)
      ${JSON.stringify(instance.steps.map(s => ({
        nodo: s.nodeId,
        ejecutadoPor: s.executedBy.name,
        fecha: s.executedAt,
        datosInsertados: s.formData,
        archivos: s.artifactsUrls
      })), null, 2)}
      
      Por favor, redacta el informe en Markdown.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.4,
      }
    });

    res.json({ markdown: response.text });
  } catch (error) {
    console.error("AI Report Error:", error);
    res.status(500).json({ error: error.message || 'Error comunicándose con Gemini para el reporte.' });
  }
};
