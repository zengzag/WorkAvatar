---
name: deep-research
description: "Conduct comprehensive, multi-source research on any topic using web search, documentation lookup, and critical analysis. This skill should be used when users request thorough investigation, deep research, or comprehensive analysis of topics including but not limited to AI systems, technology trends, academic subjects, business strategies, or current events. | 任意のトピックに対して、Web検索、ドキュメント参照、批判的分析を用いた包括的な調査を実施。徹底的な調査、詳細なリサーチ、包括的な分析が必要な場合や、AIシステム、技術トレンド、学術的テーマ、ビジネス戦略、時事問題などについて深く知りたい場合に使用。"
---

# Deep Research Skill

This skill provides a systematic approach to conducting thorough research on any topic.

## Purpose

Enable Claude to perform comprehensive research by:
1. Breaking down complex topics into researchable components
2. Using multiple information sources (web search, documentation, academic sources)
3. Applying critical thinking to synthesize findings
4. Presenting well-structured, evidence-based conclusions

## When to Use This Skill

Activate this skill when users request:
- "Deep research on [topic]"
- "Comprehensive analysis of [subject]"
- "Investigate [topic] thoroughly"
- "Research the latest information about [subject]"
- "Gather detailed information on [topic]"

**Example Topics:**
- AI agent evaluation metrics and methodologies
- Latest AI/ML news and developments
- Technology stack comparisons
- Market analysis and trends
- Academic literature reviews
- Best practices for specific domains

## Research Process

### Phase 1: Scoping & Planning

**Define Research Objectives:**
- Identify core questions to answer
- Determine scope and boundaries
- List key areas to investigate
- Establish success criteria

**Plan Information Sources:**
- Web search for current information
- Documentation (Context7) for technical details
- Academic/industry sources for authoritative information
- Community resources (GitHub, forums) for practical insights

### Phase 2: Information Gathering

**Multi-Source Search Strategy:**

1. **Broad Overview Search**
   - Use general web search for landscape understanding
   - Identify key terms, concepts, and authorities
   - Note publication dates for recency

2. **Targeted Deep Dives**
   - Search specific sub-topics identified in overview
   - Look for:
     - Official documentation
     - Academic papers
     - Industry reports
     - Expert opinions
     - Case studies
     - Code examples (when relevant)

3. **Documentation Lookup**
   - Use Context7 for library-specific documentation
   - Check official API references
   - Review changelog and release notes

4. **Cross-Reference Validation**
   - Verify claims across multiple sources
   - Check for consensus vs. outlier opinions
   - Note conflicts or controversies

### Phase 3: Critical Analysis

**Apply Critical Thinking:**

- **Source Credibility**
  - Evaluate author authority
  - Check publication/organization reputation
  - Consider potential biases
  - Verify publication dates for currency

- **Evidence Quality**
  - Distinguish facts from opinions
  - Look for empirical data
  - Assess methodology rigor
  - Check for reproducibility

- **Logical Coherence**
  - Identify logical fallacies
  - Check argument consistency
  - Evaluate reasoning chains
  - Note assumptions

- **Practical Relevance**
  - Assess real-world applicability
  - Consider implementation challenges
  - Evaluate cost-benefit tradeoffs
  - Identify gaps or limitations

### Phase 4: Synthesis & Presentation

**Structure Findings:**

1. **Executive Summary**
   - Key findings (3-5 bullet points)
   - Main conclusions
   - Critical insights

2. **Detailed Analysis**
   - Organized by theme or component
   - Evidence from multiple sources
   - Comparative analysis where applicable
   - Technical details as needed

3. **Practical Implications**
   - Actionable recommendations
   - Implementation considerations
   - Risk factors
   - Next steps

4. **Source Attribution**
   - Cite all major sources
   - Link to original materials
   - Note publication dates
   - Indicate confidence levels

**Output Format:**

```markdown
# Research: [Topic]

## Executive Summary
- Key finding 1
- Key finding 2
- Key finding 3

## Detailed Findings

### [Aspect 1]
[Analysis with sources]

### [Aspect 2]
[Analysis with sources]

## Critical Analysis
[Evaluation of evidence quality, conflicts, gaps]

## Practical Implications
[Actionable insights and recommendations]

## Sources
- [Source 1] (Date, URL)
- [Source 2] (Date, URL)

## Research Metadata
- Search queries used: [list]
- Sources consulted: [count]
- Date conducted: [date]
- Confidence level: [High/Medium/Low with explanation]
```

## Special Considerations

### For AI/ML Topics

- Check multiple perspectives (academic, industry, open-source)
- Look for benchmarks and evaluation metrics
- Review code implementations when available
- Consider ethical implications
- Note limitations and biases

### For Current Events/News

- Use recent search results (last 30 days)
- Cross-reference multiple news sources
- Distinguish reporting from opinion
- Note evolving situations
- Check for updates

### For Technical Evaluations

- Review official documentation first
- Look for community experiences
- Check GitHub issues/discussions
- Find performance benchmarks
- Assess maturity and support

### For Business/Strategy Topics

- Look for market data
- Review competitor analysis
- Check industry reports
- Consider multiple frameworks
- Assess risk factors

## Quality Checklist

Before concluding research, verify:

- [ ] Multiple authoritative sources consulted
- [ ] Recent information included (check dates)
- [ ] Key perspectives represented
- [ ] Evidence quality assessed
- [ ] Conflicts/controversies noted
- [ ] Practical implications identified
- [ ] Sources properly cited
- [ ] Confidence level stated
- [ ] Gaps/limitations acknowledged
- [ ] Actionable conclusions provided

## Tools to Use

- **WebSearch**: For general information and current events
- **WebFetch**: For detailed content from specific URLs
- **Context7**: For library/framework documentation
- **Task (Explore agent)**: For multi-step investigations
- **Critical thinking**: Throughout the process

## Iteration

If research reveals:
- **Conflicting information**: Investigate further, present multiple viewpoints
- **Insufficient information**: Expand search terms, try different sources
- **Complex sub-topics**: Break down further and research systematically
- **Outdated information**: Search for more recent sources
- **Gaps in understanding**: Ask clarifying questions to user

## Examples

**Example 1: AI Agent Evaluation**

User: "Deep research on AI agent evaluation metrics and methods"

Process:
1. Web search for "AI agent evaluation metrics 2025"
2. Web search for "LLM agent benchmarking frameworks"
3. Look for academic papers on agent evaluation
4. Check GitHub for evaluation tools/frameworks
5. Review industry reports (e.g., Stanford AI Index)
6. Synthesize: metrics categories, methods, tools, best practices
7. Present: structured report with sources

**Example 2: Latest AI News**

User: "Research the latest AI news and developments"

Process:
1. Web search for "AI news latest 2025" (last 30 days)
2. Check multiple sources: tech news sites, AI-specific outlets, academic announcements
3. Categorize: model releases, research breakthroughs, industry developments, policy changes
4. Verify claims across sources
5. Present: organized summary with dates and links

**Example 3: Technology Comparison**

User: "Deep research comparing Next.js and Remix for production apps"

Process:
1. Context7 for official documentation of both
2. Web search for "Next.js vs Remix 2025 comparison"
3. Check GitHub stars, issues, community activity
4. Look for case studies and production usage
5. Review performance benchmarks
6. Analyze: feature comparison, learning curve, ecosystem, performance
7. Present: comparative analysis with recommendations

## Notes

- **Time Estimate**: Allow 10-20 minutes for thorough research
- **Iteration**: May require follow-up questions to user for focus
- **Scope Management**: For broad topics, propose breaking into sub-topics
- **Transparency**: Always indicate confidence level and limitations
- **Recency**: Always note when information was published/updated
