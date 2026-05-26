import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let s3Client = null;

if (process.env.AWS_BUCKET_NAME) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
  });
}

/**
 * Genera una presigned URL para un archivo en S3
 * @param {string} originalUrl La URL original del archivo en S3
 * @returns {Promise<string>} La presigned URL o la original si falla/no está S3
 */
export const signS3Url = async (originalUrl) => {
  if (!s3Client || !originalUrl || !originalUrl.includes('amazonaws.com')) {
    return originalUrl; // Si no es S3 o no hay S3 config, retornar como está
  }

  try {
    // Ejemplo url: https://analizador-bpmn-119163973254-us-east-2-an.s3.us-east-2.amazonaws.com/bpm_artifacts/file.pdf
    const urlObj = new URL(originalUrl);
    // Extraer el key, que es el pathname sin el slash inicial
    const key = decodeURIComponent(urlObj.pathname.substring(1));

    const command = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    });

    // Firmar por 1 hora (3600 segundos)
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    return signedUrl;
  } catch (error) {
    console.error('Error al firmar URL de S3:', error);
    return originalUrl;
  }
};
