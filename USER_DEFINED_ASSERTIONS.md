# Feature #8: User-Defined Assertions

## Overview

The User-Defined Assertions feature empowers QA Leads to create, manage, and apply custom validation rules to test cases without writing code. These rules can be:

- **Element-based**: Check visibility, text content, attributes, state
- **Page-based**: Verify title, URL, loaded state
- **API-based**: Validate response status and content
- **JavaScript-based**: Execute custom validation logic
- **DOM-based**: Count elements, check counts

## Technical Implementation

### Backend Components

#### `server/src/services/assertionService.ts` (NEW)

A comprehensive assertion validation service with specialized validators for 11 assertion types:

**Core Assertion Types:**

1. **element_visible** - Validates element is visible and clickable
2. **element_contains_text** - Checks element contains specific text
3. **element_attribute_equals** - Validates HTML attribute value
4. **page_title_equals** - Checks page title matches
5. **page_url_contains** - Verifies URL contains substring
6. **api_response_status** - Validates HTTP response code
7. **api_response_contains** - Checks response body contains text
8. **custom_javascript** - Executes arbitrary JS code
9. **dom_element_count** - Counts matching elements
10. **element_enabled** - Validates element is not disabled
11. **element_checked** - Checks checkbox/radio state

**Key Functions:**

```typescript
export function executeAssertion(
  rule: AssertionRule,
  context: Record<string, any>
): AssertionResult
```
- Executes a single assertion rule
- Returns result with pass/fail status, message, actual vs expected

```typescript
export function executeAssertions(
  rules: AssertionRule[],
  context: Record<string, any>
): AssertionSummary
```
- Executes multiple rules
- Returns aggregated results and violations

```typescript
export function generateAssertionCode(
  rule: AssertionRule,
  language: "typescript" | "javascript" | "python"
): string
```
- Generates test code snippet for the assertion
- Supports Playwright and Python syntax

### Database Schema

#### `assertion_rules` Table

```sql
CREATE TABLE assertion_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  expected_value TEXT,
  custom_code TEXT,
  error_message TEXT,
  severity TEXT NOT NULL DEFAULT 'high',
  applicable_to TEXT NOT NULL DEFAULT 'All',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### `assertion_results` Table

```sql
CREATE TABLE assertion_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  test_name TEXT,
  passed INTEGER NOT NULL,
  message TEXT,
  actual_value TEXT,
  expected_value TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES execution_runs(id),
  FOREIGN KEY (rule_id) REFERENCES assertion_rules(id)
);
```

## Assertion Rule Structure

```typescript
export interface AssertionRule {
  id: string;
  name: string;
  description: string;
  type: AssertionType;
  target: string;                // CSS selector or description
  expectedValue?: string | number | boolean;
  customCode?: string;           // For custom_javascript
  errorMessage?: string;         // Custom error message
  severity: "critical" | "high" | "medium" | "low";
  applicable_to: string[];       // ["Smoke", "Functional", "All"]
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}
```

## Example Assertions

### Element Assertions

```json
{
  "name": "Login Button Is Visible",
  "type": "element_visible",
  "target": "button[type='submit']",
  "severity": "high",
  "errorMessage": "Submit button not visible on login form"
}
```

```json
{
  "name": "Form Title",
  "type": "element_contains_text",
  "target": "h1.form-title",
  "expectedValue": "Login",
  "severity": "medium",
  "errorMessage": "Form title mismatch"
}
```

```json
{
  "name": "Username Input Enabled",
  "type": "element_enabled",
  "target": "input#username",
  "severity": "high"
}
```

### Page Assertions

```json
{
  "name": "Correct Page Loaded",
  "type": "page_title_equals",
  "expectedValue": "Dashboard",
  "severity": "high",
  "errorMessage": "Not on dashboard page"
}
```

```json
{
  "name": "Logged In User Path",
  "type": "page_url_contains",
  "expectedValue": "/dashboard",
  "severity": "high"
}
```

### API Assertions

```json
{
  "name": "API Success Response",
  "type": "api_response_status",
  "expectedValue": 200,
  "severity": "critical"
}
```

```json
{
  "name": "API Response Contains User Data",
  "type": "api_response_contains",
  "expectedValue": "\"email\":\"user@example.com\"",
  "severity": "high"
}
```

### Custom Assertions

```json
{
  "name": "Complex Business Logic",
  "type": "custom_javascript",
  "customCode": "document.querySelectorAll('tbody tr').length > 0 && document.querySelector('.total-amount').innerText.includes('$')",
  "severity": "high",
  "errorMessage": "Business logic validation failed"
}
```

### DOM Count Assertions

```json
{
  "name": "Correct Number of Table Rows",
  "type": "dom_element_count",
  "target": "tbody tr",
  "expectedValue": 10,
  "severity": "medium"
}
```

## Assertion Result Structure

```typescript
export interface AssertionResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  message: string;
  actual?: any;
  expected?: any;
  duration?: number;
}
```

## Generated Code Examples

### TypeScript/Playwright

```typescript
// From element_visible rule
await expect(page.locator("button[type='submit']")).toBeVisible();

// From element_contains_text rule
await expect(page.locator("h1.form-title")).toContainText("Login");

// From page_title rule
await expect(page).toHaveTitle("Dashboard");

// From dom_element_count rule
await expect(page.locator("tbody tr")).toHaveCount(10);
```

### Python/Playwright

```python
# From element_visible rule
assert page.locator("button[type='submit']").is_visible()

# From element_contains_text rule
assert "Login" in page.locator("h1.form-title").inner_text()

# From page_title rule
assert page.title() == "Dashboard"
```

## Workflow

### Creating Assertions (QA Lead)

1. Navigate to Settings → Custom Assertions
2. Click "New Assertion"
3. Select assertion type
4. Specify target (selector or custom code)
5. Set expected value
6. Define error message
7. Select severity level
8. Choose applicable test categories
9. Save assertion

### Using Assertions in Tests

1. When generating test cases, system shows available assertions
2. QA Lead selects which assertions to apply
3. Assertions are automatically injected into generated scripts
4. During execution, assertions validate expected behavior

### Reviewing Results

1. Test execution includes assertion results
2. Failed assertions are highlighted in reports
3. Each result shows actual vs expected values
4. Suggestions provided for fixing failures

## Benefits

✅ **No Code Required**: Create validations via UI without writing code
✅ **Reusable Rules**: Apply same assertion to multiple tests
✅ **Customizable**: Support for custom JavaScript logic
✅ **Comprehensive**: Cover element, page, API, and DOM validation
✅ **Clear Results**: Pass/fail with actual vs expected values
✅ **Better Debugging**: Detailed error messages and suggestions
✅ **Severity-Aware**: Prioritize critical validation failures
✅ **Category-Specific**: Apply assertions only to relevant test categories

## Integration Points

### Test Case Generation

When generating test cases with assigned assertions:

```typescript
const assertions = await getApplicableAssertions(testCategory);
const code = assertions.map(rule => generateAssertionCode(rule)).join('\n');
```

### Test Execution

During test execution:

```typescript
const results = await executeAssertions(appliedRules, pageContext);
if (results.failed > 0) {
  reportTestFailure(results.violations);
}
```

### Reporting

Assertion results included in execution reports:

```typescript
{
  assertions: {
    total: 12,
    passed: 10,
    failed: 2,
    violations: [
      {
        rule: "Login Button Is Visible",
        message: "Submit button not found",
        severity: "high"
      }
    ]
  }
}
```

## Advanced Features

### Assertion Sets

Group related assertions:

```json
{
  "name": "Login Form Assertions",
  "rules": ["Username Input", "Password Input", "Submit Button", "Form Title"]
}
```

### Conditional Assertions

Applied based on test conditions:

```json
{
  "name": "Admin-Only Elements",
  "type": "element_visible",
  "target": ".admin-panel",
  "applicableTo": ["Admin Tests"],
  "condition": "user.role === 'admin'"
}
```

### Performance Tracking

Monitor assertion execution time:

```typescript
assertions.filter(result => result.duration > 1000)
  .map(result => ({
    rule: result.ruleName,
    slowness: result.duration,
    suggestion: "Consider async validation"
  }))
```

## Best Practices

1. **Specific Targets**: Use precise CSS selectors or XPath
2. **Clear Names**: Name assertions to describe what they validate
3. **Good Messages**: Custom error messages help debugging
4. **Appropriate Severity**: Match severity to business impact
5. **Regular Reviews**: Audit assertions quarterly
6. **Documentation**: Document complex custom assertions
7. **Maintainability**: Keep assertions simple and focused
8. **Reusability**: Create assertions for common patterns

## Future Enhancements

Potential additions:

1. **Visual Assertions**: Compare screenshots against baseline
2. **Performance Assertions**: Validate load times
3. **Accessibility Assertions**: Automated a11y validation
4. **API Schema Validation**: JSON Schema validation
5. **State Assertions**: Verify application state
6. **Database Assertions**: Query and validate database state
7. **Email Assertions**: Validate email content
8. **Assertion Templates**: Pre-built assertion libraries

## Testing

To test this feature:

1. Create an assertion rule in Settings
2. Apply it to a test case
3. Run the test
4. Verify assertion executed and passed/failed as expected
5. Check assertion_results table for recorded results
6. Review execution report for assertion details

## Data Analytics

Assertions enable valuable metrics:

- Which assertions fail most frequently
- Which rules prevent most bugs
- Performance trends by assertion type
- Assertion reliability across test categories
- False positive rates by assertion

## API Endpoints (Future)

When implementing REST API:

```
POST /api/assertions - Create rule
GET /api/assertions - List rules
PUT /api/assertions/{id} - Update rule
DELETE /api/assertions/{id} - Delete rule
GET /api/assertions/{id}/results - Get historical results
POST /api/assertions/validate - Execute assertions
```
