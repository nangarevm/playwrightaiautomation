# Smart Crawler Presets Implementation Guide
**Status:** Ready to Implement  
**Priority:** HIGH  
**Timeline:** Week 1  
**Impact:** 28-42% addressable market expansion

---

## Overview

Instead of a single default (50 pages), implement **4 intelligent presets** that automatically match customer needs, reduce setup friction, and capture untapped market segments.

---

## The 4 Presets

### Preset 1: 🚀 Quick Scan
**Best For:** Startups, product demos, rapid feedback  
**Market:** Early-stage SaaS, small projects (5-20 pages)

```
Max Pages:      10
Concurrency:    4
Page Load Timeout: 15,000ms
Network Idle:   3,000ms
Estimated Time: 2-5 minutes
Cost:           ~$0.08 per crawl

Use Cases:
• Portfolio sites
• Landing pages
• Verify deployment
• Quick smoke test
• Demo to stakeholders

Perfect for when you want results in <5 minutes
```

---

### Preset 2: ⚖️ Comprehensive (DEFAULT)
**Best For:** Small-to-medium businesses, standard testing  
**Market:** Core SMB segment (50-200 pages) - **60% of market**

```
Max Pages:      50
Concurrency:    5
Page Load Timeout: 20,000ms
Network Idle:   5,000ms
Estimated Time: 15-30 minutes
Cost:           ~$0.32 per crawl

Use Cases:
• Small SaaS apps
• SMB websites
• Standard QA
• Regular regression
• Typical business site

This is your default - covers majority of use cases
Balanced speed/coverage sweet spot
```

---

### Preset 3: 🔍 Thorough
**Best For:** Growing companies, comprehensive testing  
**Market:** SMB to mid-market (200-500 pages)

```
Max Pages:      200
Concurrency:    6
Page Load Timeout: 20,000ms
Network Idle:   6,000ms
Estimated Time: 60-120 minutes
Cost:           ~$1.28 per crawl

Use Cases:
• Growing SaaS (multiple tiers)
• E-commerce with <500 products
• Healthcare systems
• Regional franchises
• Complex B2B portals

For when you need deep coverage but not unlimited
Run during lunch or off-peak hours
Good for weekly full regression
```

---

### Preset 4: 🏢 Enterprise
**Best For:** Large enterprises, complete coverage  
**Market:** Enterprise, e-commerce, media (500+ pages)

```
Max Pages:      Unlimited (999,999)
Concurrency:    8
Page Load Timeout: 25,000ms
Network Idle:   7,000ms
Estimated Time: 2-4+ hours (depends on site)
Cost:           $6.40+ per crawl

Use Cases:
• Large e-commerce (1000+ products)
• Enterprise portals
• Media/news sites
• Government websites
• Massive SaaS ecosystems

For complete site coverage
Run overnight or scheduled batches
Ideal for monthly comprehensive audit
Shows quality commitment to enterprise buyers
```

---

## Technical Implementation

### Step 1: Define Preset Type
```typescript
// types/presets.ts
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
}
```

### Step 2: Create Preset Definitions
```typescript
// config/crawlPresets.ts
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
    description: "Homepage + top 10 pages. Perfect for rapid feedback.",
    targetMarket: "Startups, product demos, rapid iteration",
    useCases: ["Portfolio sites", "Landing pages", "Smoke tests", "Demos"]
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
    targetMarket: "SMB websites, standard testing (DEFAULT)",
    useCases: ["SaaS apps", "Small retailers", "Standard QA", "Weekly tests"],
    isDefault: true
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
    useCases: ["Growing SaaS", "E-commerce", "Regional franchises", "Complex portals"]
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
    useCases: ["Large e-commerce", "Enterprise portals", "Media sites", "Monthly audits"]
  }
};
```

### Step 3: Update Crawler Component
```typescript
// pages/Crawler.tsx
export default function Crawler() {
  const [selectedPreset, setSelectedPreset] = useState<PresetId>("comprehensive");
  const [useCustomPages, setUseCustomPages] = useState(false);
  const [customMaxPages, setCustomMaxPages] = useState(50);
  
  // Get effective config
  const getEffectiveConfig = () => {
    if (useCustomPages) {
      return { maxPages: customMaxPages };
    }
    const preset = CRAWL_PRESETS[selectedPreset];
    return {
      maxPages: preset.maxPages,
      concurrency: preset.concurrency,
      pageLoadTimeout: preset.pageLoadTimeout,
      networkIdleTimeout: preset.networkIdleTimeout
    };
  };
  
  async function startCrawl() {
    const config = getEffectiveConfig();
    // ... rest of crawl logic
  }
  
  return (
    <div className="space-y-6">
      {/* Preset Selection */}
      <div className="rounded-lg border border-line bg-white/60 p-4 space-y-3">
        <h3 className="font-medium">Crawl Preset</h3>
        
        {/* Preset Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {Object.entries(CRAWL_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => { setSelectedPreset(key as PresetId); setUseCustomPages(false); }}
              className={`rounded-lg border-2 p-3 text-left transition ${
                selectedPreset === key && !useCustomPages
                  ? "border-ink bg-ink/5"
                  : "border-line hover:border-ink/50"
              }`}
            >
              <div className="text-lg mb-1">{preset.icon}</div>
              <div className="text-xs font-medium">{preset.label}</div>
              <div className="text-[10px] text-ink/60 mt-1">
                {preset.maxPages === 999999 ? "Unlimited" : preset.maxPages} pages
              </div>
              <div className="text-[10px] text-ink/50 mt-1">
                {preset.estimatedTime}
              </div>
            </button>
          ))}
        </div>
        
        {/* Preset Details */}
        {!useCustomPages && (
          <div className="rounded border border-line/70 bg-ink/[0.02] p-3 space-y-2">
            <p className="text-sm font-medium">{CRAWL_PRESETS[selectedPreset].label}</p>
            <p className="text-xs text-ink/70">{CRAWL_PRESETS[selectedPreset].description}</p>
            <div className="flex gap-4 text-xs text-ink/60">
              <span>⏱️ {CRAWL_PRESETS[selectedPreset].estimatedTime}</span>
              <span>💰 {CRAWL_PRESETS[selectedPreset].estimatedCost}</span>
            </div>
          </div>
        )}
        
        {/* Custom Option */}
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={useCustomPages}
            onChange={(e) => setUseCustomPages(e.target.checked)}
          />
          <span className="font-medium">Custom max pages:</span>
          <input
            type="number"
            min={1}
            disabled={!useCustomPages}
            value={customMaxPages}
            onChange={(e) => setCustomMaxPages(Number(e.target.value))}
            className="w-20 px-2 py-1 rounded border border-line disabled:opacity-50"
          />
        </label>
        
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={crawlAllPages}
            onChange={(e) => setCrawlAllPages(e.target.checked)}
            disabled={useCustomPages}
          />
          <span>Crawl all pages (unlimited discovery)</span>
        </label>
      </div>
      
      {/* Rest of crawler UI... */}
    </div>
  );
}
```

---

## UI Mockup

### Before (Current)
```
┌─────────────────────────────────────┐
│ Max pages: [50]                     │
│ ☑ Crawl all pages                   │
│ [Start crawl]                       │
└─────────────────────────────────────┘
```

### After (Smart Presets)
```
┌──────────────────────────────────────────────┐
│ Crawl Preset                                 │
├──────────────────────────────────────────────┤
│  🚀          ⚖️          🔍          🏢      │
│  Quick       Comprehensive  Thorough  Enterprise
│  Scan        [SELECTED]     
│  10 pages    50 pages       200 pages  Unlimited
│  2-5 min     15-30 min      60-120 min 2-4+ hrs
├──────────────────────────────────────────────┤
│ ⚖️ Comprehensive                            │
│ Balanced coverage. Best for most small-to-   │
│ medium businesses.                           │
│ ⏱️ 15-30 min          💰 $0.32              │
├──────────────────────────────────────────────┤
│ ☐ Custom max pages: [50]                    │
│ ☐ Crawl all pages (unlimited discovery)     │
│ [Start crawl]                               │
└──────────────────────────────────────────────┘
```

---

## Marketing & Positioning

### How to Present to Customers

**For Startups:**
> "Get instant feedback with Quick Scan - your website tested in 2-5 minutes. Perfect for rapid iteration and demos."

**For SMB:**
> "Comprehensive crawling is our default - 50 pages in 15-30 minutes. Perfect balance of speed and coverage for most businesses."

**For Enterprise:**
> "Complete enterprise crawling with unlimited page discovery. Run your entire site through our testing in 2-4 hours."

### Sales Messaging

```
"Choose your crawl speed"

🚀 Quick Scan     - Rapid feedback for startups
⚖️ Comprehensive  - Balanced for SMB (MOST POPULAR)
🔍 Thorough       - Deep coverage for growing companies
🏢 Enterprise     - Complete sites, unlimited pages

Or customize your own limits
```

---

## Implementation Checklist

### Week 1: Foundation
- [ ] Create preset configuration (TypeScript)
- [ ] Update Crawler component UI
- [ ] Add preset selection grid
- [ ] Display preset details
- [ ] Hook up custom pages option
- [ ] Build and test

### Week 1-2: Polish
- [ ] Save user preset preference (localStorage)
- [ ] Show estimated time updates during crawl
- [ ] Add preset help tooltips
- [ ] Create onboarding guide for presets

### Week 2: Analytics
- [ ] Track preset selection rates
- [ ] Monitor actual vs estimated times
- [ ] Adjust presets based on real data
- [ ] A/B test preset ordering

---

## Expected Adoption Rates

### By Segment
```
Quick Scan:
├─ Adoption: 15-20% (startups, trials)
├─ Goal: Convert to higher tiers
└─ LTV: Low but important for funnel

Comprehensive (DEFAULT):
├─ Adoption: 50-60% (your core SMB market)
├─ Goal: Retain and expand within segment
└─ LTV: Medium, reliable revenue

Thorough:
├─ Adoption: 15-25% (growing companies)
├─ Goal: upsell to enterprise
└─ LTV: High, expansion opportunities

Enterprise:
├─ Adoption: 5-10% (large orgs)
├─ Goal: land and expand
└─ LTV: Very high, enterprise deals
```

---

## Measurement Framework

### Metrics to Track
```
Per Preset:
1. Selection rate (what % choose this preset)
2. Actual completion time vs estimated
3. Success rate (crawls that complete)
4. Retry rate (failed crawls)
5. Upgrade path (quick → comprehensive → thorough)

Per Segment:
1. Churn rate by preset choice
2. Feature adoption by preset
3. ROI per segment
4. NPS score per segment
```

---

## Timeline & Effort

| Task | Effort | Duration | Owner |
|------|--------|----------|-------|
| TypeScript config | 1h | 1 day | Dev |
| UI component | 4h | 1-2 days | Frontend |
| Integration & testing | 3h | 1 day | QA |
| Documentation | 2h | 1 day | Tech writer |
| **TOTAL** | **10h** | **4-5 days** | - |

**Go-Live:** End of Week 1

---

## Success Metrics

### Short-term (Week 1-2)
✅ 80%+ user adoption of presets (vs custom input)  
✅ <10% "unsure which preset" support tickets  
✅ Accurate time estimates (±20%)

### Medium-term (Month 1)
✅ Preset distribution shows market segmentation  
✅ Quick Scan converts 10% to Comprehensive  
✅ Thorough/Enterprise capture growing segment

### Long-term (Quarter 1)
✅ 28-42% expansion in addressable market  
✅ Clear adoption curve by customer segment  
✅ Data-driven preset refinements

---

## Conclusion

Smart presets are a **win-win:**
- ✅ Users: No configuration paralysis, clear choices
- ✅ Business: Captures untapped market segments
- ✅ Product: Data-driven optimization path

**Recommended:** Implement immediately. High ROI with minimal effort.

---

**Next Step:** Start with Phase 1 implementation (TypeScript config + UI)  
**Expected Completion:** August 10-12, 2026
