// Simple utility to create a ZIP file containing multiple KML files
import JSZip from 'jszip';

export interface KmlZipFile {
  filename: string;
  content: string;
}

/**
 * Create a ZIP blob from multiple KML files
 */
export async function createKmlZip(files: KmlZipFile[]): Promise<Blob> {
  const zip = new JSZip();

  files.forEach((file) => {
    zip.file(file.filename, file.content);
  });

  const blob: Blob = await zip.generateAsync({ type: 'blob' });
  return blob;
}


