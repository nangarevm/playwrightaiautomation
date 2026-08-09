# Feature #7: Interaction Validation

## Overview

The Interaction Validation feature provides comprehensive analysis and validation of user interactions during test execution. It monitors clicks, form inputs, navigation events, and other user actions to detect:

- **Performance Issues**: Slow interactions or timeouts
- **Behavioral Problems**: Elements not responding to clicks, form values not being set
- **Accessibility Problems**: Missing labels, ARIA attributes
- **Failures**: Interaction attempts that fail with errors

## Technical Implementation

### Backend Components

#### `server/src/services/interactionValidationService.ts` (NEW)

A comprehensive interaction validation service with specialized validators for different interaction types:

**Core Functions:**

```typescript
export function validateInteraction(interaction: InteractionEvent): InteractionValidation
```
- Routes interaction to specialized validator based on type
- Returns validation result with violations and suggestions

```typescript
export function validateClick(interaction: InteractionEvent): ValidationViolation[]
```
- Validates click interactions
- Checks for click failures, slow performance (>5s)
- Ensures proper element selection

```typescript
export function validateInput(interaction: InteractionEvent): ValidationViolation[]
```
- Validates form input interactions
- Checks for missing labels (accessibility)
- Verifies value was actually set

```typescript
export function validateSubmit(interaction: InteractionEvent): ValidationViolation[]
```
- Validates form submission
- Checks for submit button presence
- Monitors submission performance (>10s warning)

```typescript
export function validateNavigation(interaction: InteractionEvent): ValidationViolation[]
```
- Validates page navigation
- Checks navigation time thresholds
- Flags slow page loads (>5s medium, >30s high)

```typescript
export function validateInteractionSequence(interactions: InteractionEvent[]): ValidationSummary
```
- Validates a sequence of interactions
- Calculates pass/fail rates
- Computes average duration and slowest interaction

```typescript
export function detectInteractionPatterns(interactions: InteractionEvent[]): PatternAnalysis
```
- Identifies problematic patterns:
  - Repeated failures of the same type
  - Performance bottlenecks
  - Accessibility issues
  - Unexpected behaviors

### Database Schema

#### `interaction_validations` Table

```sql
CREATE TABLE interaction_validations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  test_file TEXT,
  interaction_type TEXT NOT NULL,
  element_selector TEXT,
  element_text TEXT,
  is_valid INTEGER NOT NULL,
  violations_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  suggestions_json TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES execution_runs(id)
);
```

## Validation Rules

### Click Interactions

| Rule | Severity | Condition |
|------|----------|-----------|
| Click Failed | CRITICAL | Error message present |
| Missing Selector | HIGH | No element selector captured |
| Slow Click | MEDIUM | Duration > 5000ms |

### Input Interactions

| Rule | Severity | Condition |
|------|----------|-----------|
| Input Failed | HIGH | Error message present |
| Missing Label | MEDIUM | Input has no label (accessibility) |
| Value Not Set | HIGH | Value was not applied |

### Form Submission

| Rule | Severity | Condition |
|------|----------|-----------|
| Submit Failed | CRITICAL | Error message present |
| Submit Not Found | HIGH | Submit button not located |
| Slow Submission | HIGH | Duration > 10000ms |

### Navigation

| Rule | Severity | Condition |
|------|----------|-----------|
| Navigation Failed | CRITICAL | Navigation error |
| Slow Navigation | HIGH | Duration > 30000ms |
| Moderate Navigation | MEDIUM | Duration between 5s-30s |

## Interaction Event Structure

```typescript
export interface InteractionEvent {
  type: "click" | "input" | "submit" | "navigate" | "scroll" | "hover" | "focus" | "blur";
  elementType: string;
  elementSelector?: string;
  elementText?: string;
  timestamp: number;
  resultValue?: any;
  errorMessage?: string;
  duration?: number;
}
```

## Validation Result Structure

```typescript
export interface InteractionValidation {
  event: InteractionEvent;
  isValid: boolean;
  violations: ValidationViolation[];
  warnings: ValidationWarning[];
  suggestions: string[];
}

export interface ValidationViolation {
  type: "error" | "accessibility" | "performance" | "behavior";
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  code?: string;
}
```

## Pattern Detection

The service can detect and report:

1. **Repeated Failures**: Same interaction type failing repeatedly
2. **Performance Bottlenecks**: Interactions consistently slower than expected
3. **Accessibility Issues**: Missing labels, ARIA attributes
4. **Unexpected Behaviors**: Clicks not triggering expected state changes

### Example Output

```json
{
  "repeatedFailures": [
    {
      "type": "click",
      "count": 3,
      "selector": ".submit-btn"
    }
  ],
  "performanceBottlenecks": [
    {
      "type": "navigate",
      "duration": 15000,
      "url": "https://app.example.com/checkout"
    }
  ],
  "accessibilityIssues": [
    {
      "type": "input",
      "elementSelector": "input#email"
    }
  ],
  "unexpectedBehaviors": [
    {
      "type": "click",
      "message": "Element remained hidden after click"
    }
  ]
}
```

## Integration Points

### During Test Execution

Interactions are captured and validated:
1. During automated test runs (Ultrafast/Fast modes)
2. During manual test exploration
3. During crawl operations

### Reporting

Interaction validation results are:
1. Stored in `interaction_validations` table
2. Aggregated in execution summaries
3. Surfaced in bug reports
4. Used for performance analysis

## Suggested Fixes

The system provides context-aware fixes:

```
Slow Click (>5s) 
→ Check if element is responsive, verify CSS selectors are efficient

Input Value Not Set
→ Ensure input is enabled and not obscured by overlays

Slow Navigation (>10s)
→ Profile server response time, check for missing assets

Missing Label
→ Add proper form labels for accessibility compliance

Slow Form Submission (>10s)
→ Optimize server-side processing or use background jobs
```

## Benefits

✅ **Performance Monitoring**: Track interaction speed and identify bottlenecks
✅ **Accessibility Compliance**: Detect missing labels and ARIA attributes
✅ **Pattern Recognition**: Identify systemic issues from repeated failures
✅ **Debugging Support**: Detailed suggestions for fixing validation failures
✅ **User Experience**: Ensure responsive interactions
✅ **Quality Metrics**: Quantify interaction reliability

## Data Model Integration

### ExecutionResult Enhancement

Interaction validation results are included in execution summaries:

```typescript
interface ExecutionResult {
  // ... existing fields ...
  interactionValidation?: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    avgDuration: number;
    patterns: PatternAnalysis;
  };
}
```

## Future Enhancements

Potential additions:

1. **Machine Learning**: Learn typical interaction durations per element type
2. **Threshold Customization**: QA-Lead-configurable performance thresholds
3. **Historical Trending**: Track interaction performance over time
4. **Correlation Analysis**: Find interactions that commonly fail together
5. **Auto-Remediation**: Suggest retry strategies for flaky interactions
6. **Video Annotation**: Mark video with interaction validation events
7. **Integration with CI/CD**: Fail builds on critical violations

## Testing

To test this feature:

1. Run ultrafast mode on a target application
2. Review test execution results
3. Check interaction_validations table for recorded validations
4. View patterns in execution reports
5. Verify suggested fixes are provided

## Performance Considerations

- Interaction validation occurs during test execution
- Minimal overhead (event capture + validation rules)
- Results stored in SQLite for fast queries
- Pattern detection is optional/configurable for performance-critical runs

## Accessibility Focus

Special emphasis on accessibility validation:

- Detects inputs without associated labels
- Flags missing ARIA attributes
- Suggests proper semantic HTML usage
- Helps teams meet WCAG standards

## Performance Thresholds

Configurable thresholds (can be adjusted in org_settings):

| Interaction | Default Threshold | Warning Level |
|---|---|---|
| Click | 5s | Medium |
| Input | 2s | Low |
| Submit | 10s | High |
| Navigation | 30s | High |
| Scroll | 2s | Low |

## API Integration

When implemented, would expose:

```
GET /api/runs/{runId}/interactions
GET /api/runs/{runId}/interactions/patterns
GET /api/runs/{runId}/interactions/violations
POST /api/runs/{runId}/interactions/validate-sequence
```

## Related Features

This feature works alongside:
- Feature #5: Enhanced Visual Bug Detection
- Feature #6: Console Error Deep-Dive
- Ultrafast Mode execution
- Real-time execution monitoring
- Bug prioritization and triage
