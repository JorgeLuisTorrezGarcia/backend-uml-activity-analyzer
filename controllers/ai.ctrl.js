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
