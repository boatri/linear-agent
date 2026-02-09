import { z } from "zod";

const schema = z.object({
  MEMBRANE_WORKSPACE_KEY: z.string().nonempty(),
  MEMBRANE_WORKSPACE_SECRET: z.string().nonempty(),
  MEMBRANE_CUSTOMER_ID: z.string().nonempty(),
  MEMBRANE_CONNECTION_SELECTOR: z.string().default("linear"),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  const lines = result.error.issues.map((i) => `  ✖ ${i.path.join(".")}: ${i.message}`);
  console.error("Invalid environment variables:\n" + lines.join("\n"));
  process.exit(1);
}

export const env = result.data;
