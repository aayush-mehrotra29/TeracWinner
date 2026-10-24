import OpenAI from "openai";
import { required } from "./config";
export function openai() {
  return new OpenAI({ apiKey: required("OPENAI_API_KEY"), maxRetries: 0, timeout: 15000 });
}
