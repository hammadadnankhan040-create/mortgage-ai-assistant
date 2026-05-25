# Mortgage AI Assistant

A browser-based AI-powered mortgage compliance and underwriting tool built for UK mortgage administrators.

## What It Does

Analyses client mortgage documents against 8 UK regulatory rule sets and produces a full compliance and affordability report.

### Document Analysis
- **Proof of ID** — image quality checks (glare, corners, blur), expiry validation, non-UK passport UKVI prompt
- **Proof of Address** — KYC date and name verification only
- **Bank Statements** — AML checks (MLR 2017/JMLSG), income matching, deposit trail analysis
- **Payslips** — tax code analysis (K, M1/W1, BR, OT, D0/D1), employment continuity, income verification
- **P60 / P45** — year-on-year income trend, NI number consistency, P45 accepted where client left employer
- **SA302 / Tax Year Overview** — SA302 vs TYO cross-match for fraud detection
- **Company Accounts** — solvency check, Companies House live verification
- **Credit Report** — CCJs, defaults, repossessions, missed payments, IVA, DMP, AP markers
- **Gifted Deposit** — gift letter, donor ID, donor bank statement verification

### Compliance Rules Applied
- FCA MCOB 11.6 — Affordability assessment (4.5x income limit)
- FCA MCOB 11.6.5 — Interest rate stress test at 6%
- MLR 2017 — AML and source of funds checks
- JMLSG Guidance — Transaction monitoring
- KYC/MLR 2017 — Identity verification
- UK GDPR / DPA 2018 — Data protection

### Key Features
- **Cross-document matching** — name, address, NI number, salary figures compared across all uploaded documents
- **Full MCOB 11.6.5 stress test** — net income minus committed expenditure minus stressed mortgage payment
- **Blended income calculator** — salary, rental income, dividends, contractor day rate
- **Companies House live lookup** — status, incorporation date, accounts due, confirmation statement dates
- **Gifted deposit detection** — flags gift vs savings, checks donor evidence
- **Retirement age check** — uses DOB from ID + mortgage term
- **Enhanced due diligence trigger** — flags source of wealth requirement above £500,000
- **Leasehold remaining term check** — flags if lease too short for mortgage term
- **New build and ex-council flags** — LTV restrictions applied
- **Purchase scheme handling** — Right to Buy, Help to Buy, Shared Ownership, First Homes
- **Serial upload queue** — manages API rate limits automatically
- **Save/load sessions** — up to 10 sessions stored in browser
- **Export** — downloadable PDF report, CSV, JSON

## Tech Stack
- React (hooks — useState, useRef, useCallback)
- Anthropic Claude API (claude-sonnet-4-6) with web search
- Companies House public data via AI web search
- Pure inline CSS — no external UI libraries
- localStorage for session persistence

## Running Locally

Requires Node.js 18+ and an Anthropic API key.

```bash
npx create-react-app mortgage-bot
cd mortgage-bot
npm install express cors dotenv concurrently
```

Replace `src/App.js` with `mortgage-ai-bot.jsx`. Add your Anthropic API key to `.env`. Run with `npm run dev`.

## Disclaimer
This tool is for administrative and compliance-checking purposes only. It does not constitute regulated financial advice under FSMA 2000. All findings must be verified by a qualified FCA-authorised mortgage advisor.
