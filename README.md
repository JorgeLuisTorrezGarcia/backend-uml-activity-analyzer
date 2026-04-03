# Backend Servidor - UML Flow SaaS

Este directorio contiene el API RESTful y el Servidor de WebSockets (Socket.io) que da vida a la plataforma SaaS de Diagramación. Está construido en Node.js, Express, y utiliza PostgreSQL mediante Prisma ORM para persistencia y control de sesiones seguras.

## Tecnologías Principales
- **Node.js + Express:** Framework robusto para creación del API.
- **PostgreSQL + Prisma:** Base de datos relacional para guardar Usuarios, Diagramas persistentes, Colaboradores y Notificaciones.
- **Socket.io:** Mantiene múltiples canales TCP multiplexados en tiempo real para sincronizar las coordenadas y ediciones de diagramas entre diseñadores concurrentes.
- **Seguridad (JWT & Bcrypt):** Las sesiones se manejan por JSON Web Token pasados vía Bearer Authorization.
- **Criptografía AES-256:** Cifra datos extremadamente sensibles como la *API KEY de Google Gemini* ingresadas por los usuarios.
- **Integración `@google/genai`:** Proxy seguro en backend que recibe los prompts de la interfaz de usuario, desencripta la llave local y forja JSONs de diagramas a través de Modelos LLM de Google.

## Estructura de Endpoints de la API `/api`

### 🔒 Autenticación (`/auth`)
- `POST /register`: Crea una cuenta nueva.
- `POST /login`: Valida email y password encriptado. Retorna el UUID y JWT.
- `GET /me`: Obtiene el contexto del usuario actual comprobando el Header JWT.
- `PUT /settings`: Upsert de configuraciones, específicamente para guardar de forma encriptada el Token de Gemini AI.
- `GET /notifications`: Devuelve las alertas de invitación generadas en la plataforma.
- `PUT /notifications/read`: Marca los mensajes In-App como leídos (Notification Bell logic).

### 📐 Gestor de Diagramas (`/diagrams`)
- `GET /`: Devuelve dualidad de esquemas: Los *Diagramas Propios* y los *Diagramas Compartidos* con el usuario (A través de invitaciones).
- `POST /`: Genera un nuevo documento en formato vacío y lo liga al `ownerId`.
- `PUT /:id`: Actualiza en la Base de Datos un snapshot del estado del Canvas.
- `DELETE /:id`: Eliminación física delegada al propietario.
- `POST /:diagramId/invite`: Agrega un colaborador mediante email, le asigna permisos y desencadena una notificación interna.

### 🤖 Proxy Inteligencia Artificial (`/ai`)
- `POST /generate`: Endpoint crucial. Alimenta a Gemini con un *System Instruction* riguroso y el JSON actual, solicitando una iteración completa o inicial del diagrama según el *prompt* dictado, y devuelve el String manipulado.

## Instrucciones del Servidor

1. La clave de encriptación general debe ser una cadena aleatoria de tamaño exacto a 32 bytes (64 hex charset). Esta llave debe vivir en su `.env` bajo `ENCRYPTION_KEY=...`
2. El Database String local de Prisma debe apuntar al esquema activo (Generalmente `postgresql://user:pass@localhost:5432/analizador_db`).
3. Comandos vitales:
   ```bash
   npm i
   # Generar cliente prisma a la medida
   npm run db:generate
   # Empujar cambios a la BD en caso de alterar schema.prisma
   npm run db:push
   # Arrancar servidor en modo normal (Puerto 3001)
   npm start
   ```
