# Backend Servidor - UML Flow SaaS

Este directorio contiene el API RESTful y el Servidor de WebSockets (Socket.io) que da vida a la plataforma SaaS de Diagramación. Está construido en Node.js, Express, y utiliza PostgreSQL mediante Prisma ORM para persistencia y control de sesiones seguras.

## Tecnologías Principales
- **Node.js + Express:** Framework robusto para creación del API.
- **PostgreSQL + Prisma:** Base de datos relacional para guardar Usuarios, Diagramas persistentes, Colaboradores y Notificaciones.
- **Socket.io:** Mantiene múltiples canales TCP multiplexados en tiempo real para sincronizar las coordenadas y ediciones de diagramas entre diseñadores concurrentes.
- **Criptografía AES-256** 
- **Integración `@google/genai`** 


## Instrucciones del Servidor

1. La clave de encriptación general debe ser una cadena aleatoria de tamaño exacto a 32 bytes (64 hex charset). Esta llave debe vivir en su `.env`.
2. El Database String local de Prisma debe apuntar al esquema activo (Generalmente `postgresql://user:pass@localhost:5432/analizador_db`).
3. Comandos vitales:
   ```bash
   npm i
   # Generar cliente prisma a la medida
   npm run db:generate

   npm run db:migrate

   # Empujar cambios a la BD en caso de alterar schema.prisma
   npm run db:push
   # Arrancar servidor en modo normal (Puerto 3001)
   npm start
   ```
