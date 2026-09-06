// Master-prompt #5: review/manage the OpenAPI/Swagger contract cached per
// origin -- see openApiContractService.ts.
import { Router } from "express";
import { deleteOpenApiSpec, discoverAndCacheOpenApiSpec, getOpenApiSpecForOrigin } from "../services/openApiContractService.js";
import { requireRole } from "../services/adminService.js";
import { errBody } from "../errorCodes.js";

export const openApiContractsRouter = Router();

openApiContractsRouter.get("/", (req, res) => {
  const { baseUrl } = req.query as { baseUrl?: string };
  if (!baseUrl) return res.status(400).json(errBody(400, "baseUrl query param is required."));
  const spec = getOpenApiSpecForOrigin(baseUrl);
  res.json(spec ?? { base_url: baseUrl, found: 0, discovered: false });
});

// On-demand discovery -- normally triggered automatically the first time a
// scan visits an origin, but useful to re-run right after a deploy (a spec
// that didn't exist last time, or has since changed) without waiting for a
// full re-crawl. Explicitly clears the cached result first so this always
// re-probes rather than returning the old cached answer.
openApiContractsRouter.post("/discover", requireRole("QA Lead"), async (req, res) => {
  const { baseUrl } = req.body as { baseUrl?: string };
  if (!baseUrl) return res.status(400).json(errBody(400, "baseUrl is required."));
  try {
    deleteOpenApiSpec(baseUrl);
    res.json(await discoverAndCacheOpenApiSpec(baseUrl));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Discovery failed."));
  }
});

openApiContractsRouter.delete("/", requireRole("QA Lead"), (req, res) => {
  const { baseUrl } = req.query as { baseUrl?: string };
  if (!baseUrl) return res.status(400).json(errBody(400, "baseUrl query param is required."));
  deleteOpenApiSpec(baseUrl);
  res.status(204).end();
});
