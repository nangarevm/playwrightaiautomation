// Deeper Bug Detection #2: review/edit the API response schemas captured
// during a crawl/execution -- list every endpoint seen, switch an endpoint
// between 'baseline' (accept current shape) and 'strict' (flag drift), and
// re-baseline or delete a stored schema.
import { Router } from "express";
import {
  deleteApiSchema,
  getApiSchema,
  listApiSchemas,
  resetApiSchemaBaseline,
  updateApiSchemaMode,
} from "../services/apiSchemaService.js";
import { requireRole } from "../services/adminService.js";
import { errBody } from "../errorCodes.js";

export const apiSchemasRouter = Router();

apiSchemasRouter.get("/", (req, res) => {
  const { siteId } = req.query as { siteId?: string };
  res.json(listApiSchemas(siteId));
});

apiSchemasRouter.get("/:id", (req, res) => {
  const schema = getApiSchema(req.params.id);
  if (!schema) return res.status(404).json(errBody(404, "API schema not found."));
  res.json(schema);
});

apiSchemasRouter.put("/:id/mode", requireRole("QA Lead"), (req, res) => {
  const { mode } = req.body as { mode?: string };
  try {
    res.json(updateApiSchemaMode(req.params.id, mode as any));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Re-baseline from the endpoint's own last-captured sample -- for after an
// intentional API change, so future drift is diffed against the new shape.
apiSchemasRouter.post("/:id/reset-baseline", requireRole("QA Lead"), (req, res) => {
  try {
    res.json(resetApiSchemaBaseline(req.params.id));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

apiSchemasRouter.delete("/:id", requireRole("QA Lead"), (req, res) => {
  deleteApiSchema(req.params.id);
  res.status(204).end();
});
