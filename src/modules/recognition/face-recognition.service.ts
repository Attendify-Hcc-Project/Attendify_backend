import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs';
import '@tensorflow/tfjs-backend-wasm';
import { Canvas, Image, ImageData, loadImage } from 'canvas';
// Polyfill TextEncoder and TextDecoder for the browser build of face-api.js
import * as util from 'util';
(global as any).TextEncoder = util.TextEncoder;
(global as any).TextDecoder = util.TextDecoder;

import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js';


@Injectable()
export class FaceRecognitionService implements OnModuleInit {
  private readonly logger = new Logger(FaceRecognitionService.name);
  private isModelLoaded = false;

  constructor(private configService: ConfigService) {
    // Configure face-api env to use node-canvas components
    faceapi.env.monkeyPatch({ Canvas, Image, ImageData } as any);
  }

  async onModuleInit() {
    try {
      const modelsPath = path.join(process.cwd(), 'models');

      await (faceapi.tf as any).setBackend('wasm');
      await (faceapi.tf as any).ready();

      // Check if models folder exists, if not, create it
      if (!fs.existsSync(modelsPath)) {
        fs.mkdirSync(modelsPath, { recursive: true });
        this.logger.warn(`Created empty models folder at ${modelsPath}. Please place face-api.js weight files here.`);
      }

      this.logger.log(`Loading face-api.js models from: ${modelsPath}`);

      // Load face-api models
      await faceapi.nets.tinyFaceDetector.loadFromDisk(modelsPath);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);

      this.isModelLoaded = true;
      this.logger.log('Face recognition engine initialized and models loaded successfully');
    } catch (err) {
      this.logger.error('Failed to load face-api.js models. Face recognition will run in fallback mock mode.', err.stack);
    }
  }

  /**
   * Computes face embeddings from an image buffer using face-api.js
   * Returns descriptors and cropped canvases for any detected faces
   */
  async processImageBuffer(imageBuffer: Buffer): Promise<Array<{ descriptor: Float32Array; boundingBox: faceapi.Box; croppedBuffer: Buffer }>> {
    if (!this.isModelLoaded) {
      this.logger.warn('Models not loaded. Using fallback mock generator for testing.');
      return this.generateMockDetections();
    }

    try {
      const img = await loadImage(imageBuffer);
      const canvas = new Canvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const detections = await faceapi
        .detectAllFaces(canvas as any, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptors();

      const results = [];

      for (const det of detections) {
        const box = det.detection.box;

        // Pad the crop by 30% so face-api can detect it reliably later
        const padW = box.width * 0.3;
        const padH = box.height * 0.3;
        const x = Math.max(0, box.x - padW);
        const y = Math.max(0, box.y - padH);
        const width = Math.min(img.width - x, box.width + padW * 2);
        const height = Math.min(img.height - y, box.height + padH * 2);

        const faceCanvas = new Canvas(width, height);
        const faceCtx = faceCanvas.getContext('2d');
        faceCtx.drawImage(
          img,
          x, y, width, height,
          0, 0, width, height
        );

        results.push({
          descriptor: det.descriptor,
          boundingBox: box,
          croppedBuffer: faceCanvas.toBuffer('image/jpeg'),
        });
      }

      return results;
    } catch (err) {
      this.logger.error('Error processing image frame for face detection', err);
      return [];
    }
  }

  /**
   * Mock face detection generator for local sandbox testing when models are missing
   */
  private generateMockDetections() {
    // 5% chance to trigger a mock detection when models aren't loaded for demo robustness
    if (Math.random() > 0.05) return [];

    this.logger.log('[Mock Detection] Simulating face detection event');
    const mockDescriptor = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      mockDescriptor[i] = Math.random();
    }

    return [{
      descriptor: mockDescriptor,
      boundingBox: new faceapi.Box({ x: 100, y: 100, width: 200, height: 200 }),
      croppedBuffer: Buffer.from([]),
    }];
  }
}
