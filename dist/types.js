/**
 * Shared domain types for the review swarm.
 *
 * The JSON Schemas here are handed straight to the local engines
 * (`claude --json-schema`, `codex exec --output-schema`) so they must stay inside the
 * strict structured-output subset: every property listed in `required`,
 * `additionalProperties: false`, optionality expressed as a nullable type.
 */
export const SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'];
export const VERDICTS = ['REQUEST_CHANGE', 'SUGGESTION', 'FOLLOW_UP', 'QUESTION', 'DROP'];
/** How much authority a persona has over the merge decision. */
export const AGENT_CLASSES = ['gate', 'analyst', 'value', 'mediator'];
export const SEVERITY_RANK = {
    blocker: 4,
    high: 3,
    medium: 2,
    low: 1,
    info: 0,
};
export const VERDICT_RANK = {
    REQUEST_CHANGE: 4,
    SUGGESTION: 3,
    FOLLOW_UP: 2,
    QUESTION: 1,
    DROP: 0,
};
// ---------------------------------------------------------------------------
// JSON Schemas handed to the engines
// ---------------------------------------------------------------------------
export const FINDINGS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'notes'],
    properties: {
        notes: {
            type: ['string', 'null'],
            description: 'Optional one-paragraph note about coverage or what you could not verify.',
        },
        findings: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: [
                    'file',
                    'start_line',
                    'end_line',
                    'side',
                    'severity',
                    'confidence',
                    'category',
                    'title',
                    'rationale',
                    'evidence',
                    'scenario',
                    'suggested_fix',
                    'suggestion_patch',
                ],
                properties: {
                    file: { type: 'string', description: 'Repo-relative path exactly as it appears in the diff.' },
                    start_line: { type: 'integer', description: 'First line of the finding, in the file version named by `side`.' },
                    end_line: { type: 'integer', description: 'Last line of the finding. Equal to start_line for a single line.' },
                    side: { type: 'string', enum: ['RIGHT', 'LEFT'], description: 'RIGHT = post-change file, LEFT = pre-change file.' },
                    severity: { type: 'string', enum: [...SEVERITIES] },
                    confidence: { type: 'number', description: '0.0 - 1.0. Below 0.5 means you are guessing; do not emit it.' },
                    category: { type: 'string', description: 'Short kebab-case slug, e.g. missing-authz, n-plus-one, tx-boundary.' },
                    title: { type: 'string', description: 'One line, under 80 chars.' },
                    rationale: { type: 'string', description: 'Why this is a defect, in your persona voice.' },
                    evidence: { type: 'string', description: 'Concrete code references (file:line) or command output that proves it.' },
                    scenario: { type: 'string', description: 'Reproducible failure/attack/change scenario. Not a hypothetical.' },
                    suggested_fix: { type: 'string', description: 'The smallest change that resolves it.' },
                    suggestion_patch: {
                        type: ['string', 'null'],
                        description: 'Optional replacement text for exactly the lines start_line..end_line, rendered as a GitHub suggestion block. Null when a patch would be guesswork.',
                    },
                },
            },
        },
    },
};
export const VERIFY_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['refuted', 'reason', 'adjusted_severity', 'adjusted_confidence'],
    properties: {
        refuted: {
            type: 'boolean',
            description: 'true when the finding does not hold: wrong, already handled elsewhere, or not reachable.',
        },
        reason: { type: 'string', description: 'Evidence for your verdict, citing file:line.' },
        adjusted_severity: { type: ['string', 'null'], description: 'One of blocker/high/medium/low/info, or null to keep.' },
        adjusted_confidence: { type: ['number', 'null'], description: '0.0 - 1.0, or null to keep.' },
    },
};
export const DEBATE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['position', 'concession', 'counter_proposal'],
    properties: {
        position: { type: 'string', description: 'Your stance after reading the opposing finding.' },
        concession: { type: 'string', description: 'What the other persona is right about. Empty string if nothing.' },
        counter_proposal: { type: 'string', description: 'The smallest change both of you could accept.' },
    },
};
export const MEDIATOR_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'decisions'],
    properties: {
        summary: { type: 'string', description: 'Two to five sentences for the PR author. Korean.' },
        decisions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'verdict', 'reason', 'merged_body'],
                properties: {
                    id: { type: 'string', description: 'The finding id you were given. Never invent one.' },
                    verdict: { type: 'string', enum: [...VERDICTS] },
                    reason: { type: 'string', description: 'One or two sentences comparing the cost of each option.' },
                    merged_body: {
                        type: ['string', 'null'],
                        description: 'Rewritten comment body when you merged duplicates, otherwise null.',
                    },
                },
            },
        },
    },
};
//# sourceMappingURL=types.js.map