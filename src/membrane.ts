import { MembraneClient } from "@membranehq/sdk";
import jwt from "jsonwebtoken";

const workspaceKey = process.env.MEMBRANE_WORKSPACE_KEY;
const workspaceSecret = process.env.MEMBRANE_WORKSPACE_SECRET;
const customerId = process.env.MEMBRANE_CUSTOMER_ID;

if (!workspaceKey || !workspaceSecret || !customerId) {
  throw new Error("MEMBRANE_WORKSPACE_KEY, MEMBRANE_WORKSPACE_SECRET, and MEMBRANE_CUSTOMER_ID must be set");
}

export const membrane = new MembraneClient({
  fetchToken: async () =>
    jwt.sign(
      { workspaceKey, id: customerId },
      workspaceSecret,
      { expiresIn: 7200, algorithm: "HS512" },
    ),
});
