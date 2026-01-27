// @ts-ignore - JSZip may not have TypeScript types installed
import JSZip from 'jszip';

/**
 * Create a ZIP file from multiple files
 * @param files Array of { name: string, content: string | Blob }
 * @returns Blob containing the ZIP file
 */
export async function createZipFile(
  files: Array<{ name: string; content: string | Blob }>
): Promise<Blob> {
  const zip = new JSZip();

  for (const file of files) {
    if (typeof file.content === 'string') {
      zip.file(file.name, file.content);
    } else {
      // Convert Blob to array buffer
      const arrayBuffer = await file.content.arrayBuffer();
      zip.file(file.name, arrayBuffer);
    }
  }

  return await zip.generateAsync({ type: 'blob' });
}

