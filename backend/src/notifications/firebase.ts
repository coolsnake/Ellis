// Firebase Admin SDK initialization for push notifications

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';

let firebaseAdmin: typeof import('firebase-admin') | null = null;
let firebaseInitialized = false;

const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_ADMIN_PATH 
  || resolve('config', 'firebase-admin.json');

/**
 * Initialize Firebase Admin SDK
 * Returns true if initialization successful, false otherwise
 */
export async function initFirebase(): Promise<boolean> {
  if (firebaseInitialized) return true;

  try {
    // Check if service account file exists
    if (!existsSync(SERVICE_ACCOUNT_PATH)) {
      logger.info('notifications: Firebase service account not found, push notifications disabled', {
        path: SERVICE_ACCOUNT_PATH,
        cat: 'notifications',
      });
      return false;
    }

    // Dynamically import firebase-admin
    const admin = await import('firebase-admin');
    firebaseAdmin = admin.default || admin;

    // Read and parse service account
    const serviceAccountJson = readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8');
    const serviceAccount = JSON.parse(serviceAccountJson);

    // Initialize the app
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount),
    });

    firebaseInitialized = true;
    logger.info('notifications: Firebase Admin SDK initialized', { cat: 'notifications' });
    return true;
  } catch (err: any) {
    logger.warn('notifications: Failed to initialize Firebase Admin SDK', {
      error: String(err?.message || err),
      cat: 'notifications',
    });
    return false;
  }
}

/**
 * Get Firebase Messaging instance
 * Returns null if Firebase is not initialized
 */
export function getMessaging(): import('firebase-admin').messaging.Messaging | null {
  if (!firebaseInitialized || !firebaseAdmin) return null;
  try {
    return firebaseAdmin.messaging();
  } catch {
    return null;
  }
}

/**
 * Check if Firebase is initialized and ready
 */
export function isFirebaseReady(): boolean {
  return firebaseInitialized && firebaseAdmin !== null;
}
