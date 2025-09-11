import dotenv from "dotenv";
import type { Address } from "viem";
import path from "node:path";

// Load .env in a way that works with ESM (no __dirname)
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function getEnvVar<T extends string = string>(key: string, required = true): T {
  const value = process.env[key];
  if (required && (value === undefined || value === "")) {
    throw new Error(`${key} is not defined or is empty in the .env file`);
  }
  return value as T;
}

export const WHITELISTED_WALLET_PRIVATE_KEY = getEnvVar<Address>(
  "WHITELISTED_WALLET_PRIVATE_KEY"
);

export const BUYER_AGENT_WALLET_ADDRESS = getEnvVar<Address>(
  "BUYER_AGENT_WALLET_ADDRESS"
);

export const BUYER_ENTITY_ID = parseInt(getEnvVar("BUYER_ENTITY_ID"));

export const SELLER_AGENT_WALLET_ADDRESS = getEnvVar<Address>(
  "SELLER_AGENT_WALLET_ADDRESS"
);

export const SELLER_ENTITY_ID = parseInt(getEnvVar("SELLER_ENTITY_ID"));

export const SQDGN_API_KEY = getEnvVar("SQDGN_API_KEY");

const entities = {
  BUYER_ENTITY_ID,
  SELLER_ENTITY_ID,
};

for (const [key, value] of Object.entries(entities)) {
  if (isNaN(value)) throw new Error(`${key} must be a valid number`);
}
