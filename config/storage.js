'use strict';
const fs   = require('fs');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

function _azureClient() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) return null;
  return BlobServiceClient.fromConnectionString(cs);
}

/**
 * Save an uploaded file (multer file object) to storage.
 * Returns the URL / local path that should be stored in the DB.
 * folder = 'sources' | 'exports' | etc.
 */
async function saveUpload(file, folder = 'sources') {
  const client = _azureClient();
  if (client) {
    const container = process.env.AZURE_STORAGE_CONTAINER || 'transformiq-assn';
    const cc   = client.getContainerClient(container);
    await cc.createIfNotExists({ access: 'blob' });
    const blobName = `${folder}/${file.filename}`;
    const bc = cc.getBlockBlobClient(blobName);
    await bc.uploadFile(file.path);
    fs.unlinkSync(file.path); // remove temp file
    return bc.url;
  }
  // Local disk — file already in public/uploads/sources by multer
  return `/uploads/${folder}/${file.filename}`;
}

/**
 * Save a Buffer (generated export) to storage and return its URL/path.
 */
async function saveBuffer(buffer, filename, folder = 'exports') {
  const client = _azureClient();
  if (client) {
    const container = process.env.AZURE_STORAGE_CONTAINER || 'transformiq-assn';
    const cc   = client.getContainerClient(container);
    await cc.createIfNotExists({ access: 'blob' });
    const blobName = `${folder}/${filename}`;
    const bc = cc.getBlockBlobClient(blobName);
    await bc.upload(buffer, buffer.length);
    return bc.url;
  }
  const dir = path.join(UPLOAD_DIR, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
  return `/uploads/${folder}/${filename}`;
}

/**
 * Delete a file by its stored URL/path.
 */
async function deleteUpload(url) {
  if (!url) return;
  const client = _azureClient();
  if (client && url.startsWith('http')) {
    try {
      const container = process.env.AZURE_STORAGE_CONTAINER || 'transformiq-assn';
      const cc = client.getContainerClient(container);
      const blobName = new URL(url).pathname.split('/').slice(2).join('/');
      await cc.getBlockBlobClient(blobName).deleteIfExists();
    } catch (_) {}
    return;
  }
  try {
    const local = path.join(__dirname, '..', 'public', url.replace(/^\//, ''));
    if (fs.existsSync(local)) fs.unlinkSync(local);
  } catch (_) {}
}

module.exports = { saveUpload, saveBuffer, deleteUpload };
