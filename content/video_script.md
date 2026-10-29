# Breakpoint 2026 OCM Machine-Paid Inference Video Script

## Video Details
- **Duration**: 40 seconds (±0.1s after final render)
- **Format**: Vertical (1080 × 1920)
- **Theme**: OCM (Open inference network) and how Solana can be settlement layer for machines buying variable-cost inference

## Video Script

### [0:00-0:04] INTRO
**Visual**: Animated OCM logo with "Breakpoint 2026" badge
**On-screen**: "Machine-Paid Inference"
**Narrator**: "Imagine AI that only charges you for what you actually use."

### [0:04-0:08] OPENAI CLIENT REQUEST
**Visual**: Code snippet showing OpenAI client request
```javascript
const response = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer $OPENAI_API_KEY' },
  body: JSON.stringify({
    model: "gpt-4",
    messages: [{ role: "user", content: "Explain quantum computing" }]
  })
});
```
**On-screen**: "Client Request"
**Narrator**: "Your AI request is sent to the network."

### [0:08-0:15] OCM PROVIDER/MODEL/STREAM STATUS
**Visual**: Real-time status dashboard showing:
- Provider: "OCM-Alibaba"
- Model: "qwen2.5-72b"
- Stream Status: "streaming"
- Cost: "$0.0015 per inference"
**On-screen**: "OCM Provider Status"
**Narrator**: "The network finds the best provider and starts streaming your response."

### [0:15-0:20] CAP→STREAM→SETTLE DIAGRAM
**Visual**: Animated flow diagram:
1. CAP (Request cap/limit)
   ↓
2. STREAM (Real-time streaming)
   ↓
3. SETTLE (Payment settlement on Solana)
**On-screen**: "Cap → Stream → Settle"
**Narrator**: "Your request is capped, streamed, and automatically settled."

### [0:20-0:24] PAYMENT BADGE
**Visual**: Payment confirmation with Solana logo
**On-screen**: "You only pay $0.0015 per inference."
**Narrator**: "You only pay for what you use – a fraction of a cent per request."

### [0:24-0:29] SETTLE ARROW
**Visual**: Arrow animation showing payment flow
**On-screen**: "Payment settles automatically."
**Narrator**: "When the stream finishes, the payment settles on the ledger."

### [0:29-0:33] ANSWER DISPLAYED
**Visual**: Final AI response displayed
**On-screen**: "Your answer, instantly delivered."
**Narrator**: "Fast, transparent, and cost-effective AI."

### [0:33-0:37] CTA
**Visual**: Call-to-action with Breakpoint 2026 branding
**On-screen**: "Try machine-paid inference today! #Breakpoint2026 #OCM #MachinePaidInference"
**Narrator**: "Join the future of AI payments."

## Technical Requirements
- **No wallet balance display**
- **No API keys shown**
- **No private prompts displayed**
- **Focus on transparency and cost efficiency**

## Audio Requirements
- Clear, professional narration
- Upbeat, tech-focused background music
- Sound effects for transitions (subtle)