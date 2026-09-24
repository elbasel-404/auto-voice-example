"use server";

import { GoogleGenAI } from "@google/genai";

/**
 * Mints a single-use ephemeral token for the Gemini Live API.
 *
 * A Live session is a long-lived WebSocket, which a server action can't hold
 * open (actions are request/response). So the server's only job is to keep
 * GEMINI_API_KEY secret and hand the browser a short-lived token; the client
 * component then connects to the Live API directly.
 *
 * NOTE: add your own auth/rate limiting here before shipping - anyone who can
 * call this action can obtain a token.
 */
export async function createLiveToken(): Promise<string> {
  const apiKey = "AQ.Ab8RN6LnVH1olzVDgW1NUMHFA9gG8IuqkzFC3L16_IN4YSRm6g";
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" }, // required for ephemeral tokens
  });

  const now = Date.now();
  const token = await ai.authTokens.create({
    config: {
      uses: 1, // one session per token
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(), // session may last up to 30 min
      newSessionExpireTime: new Date(now + 60 * 1000).toISOString(), // must connect within 1 min
    },
  });

  if (!token.name) {
    throw new Error("Failed to create ephemeral token");
  }
  return token.name;
}
