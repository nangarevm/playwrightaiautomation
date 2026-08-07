// Smart Crawl Presets based on 2026 market analysis
// Segments websites into 4 tiers matching real-world use cases

export type PresetId = "quick" | "comprehensive" | "thorough" | "enterprise";

export interface CrawlPreset {
  id: PresetId;
  label: string;
  icon: string;
  maxPages: number;
  concurrency: number;
  pageLoadTimeout: number;
  networkIdleTimeout: number;
  estimatedTime: string;
  estimatedCost: string;
  description: string;
  targetMarket: string;
  useCases: string[];
  isDefault?: boolean;
}

export const CRAWL_PRESETS: Record<PresetId, CrawlPreset> = {
  quick: {
    id: "quick",
    label: "Quick Scan",
    icon: "🚀",
    maxPages: 10,
    concurrency: 4,
    pageLoadTimeout: 15000,
    networkIdleTimeout: 3000,
    estimatedTime: "2-5 min",
    estimatedCost: "$0.08",
    description: "Homepage + top 10 pages. Perfect for rapid feedback and testing.",
    targetMarket: "Startups, product demos, rapid iteration",
    useCases: ["Portfolio sites", "Landing pages", "Smoke tests", "Demos"],
  },

  comprehensive: {
    id: "comprehensive",
    label: "Comprehensive",
    icon: "⚖️",
    maxPages: 50,
    concurrency: 5,
    pageLoadTimeout: 20000,
    networkIdleTimeout: 5000,
    estimatedTime: "15-30 min",
    estimatedCost: "$0.32",
    description: "Balanced coverage. Best for most small-to-medium businesses.",
    targetMarket: "SMB websites, standard testing (RECOMMENDED)",
    useCases: ["SaaS apps", "Small retailers", "Standard QA", "Weekly tests"],
    isDefault: true,
  },

  thorough: {
    id: "thorough",
    label: "Thorough",
    icon: "🔍",
    maxPages: 200,
    concurrency: 6,
    pageLoadTimeout: 20000,
    networkIdleTimeout: 6000,
    estimatedTime: "60-120 min",
    estimatedCost: "$1.28",
    description: "Deep coverage. For growing companies needing comprehensive testing.",
    targetMarket: "SMB to mid-market, comprehensive testing",
    useCases: ["Growing SaaS", "E-commerce", "Regional franchises", "Complex portals"],
  },

  enterprise: {
    id: "enterprise",
    label: "Enterprise",
    icon: "🏢",
    maxPages: 999999,
    concurrency: 8,
    pageLoadTimeout: 25000,
    networkIdleTimeout: 7000,
    estimatedTime: "2-4+ hrs",
    estimatedCost: "$6.40+",
    description: "Complete coverage. For large enterprises and full site audits.",
    targetMarket: "Large enterprises, complete coverage required",
    useCases: ["Large e-commerce", "Enterprise portals", "Media sites", "Monthly audits"],
  },
};

export function getPreset(id: PresetId): CrawlPreset {
  return CRAWL_PRESETS[id];
}

export function getDefaultPreset(): CrawlPreset {
  return CRAWL_PRESETS.comprehensive;
}

export function getAllPresets(): CrawlPreset[] {
  return Object.values(CRAWL_PRESETS);
}
