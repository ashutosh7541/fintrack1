# FinTrack

A personal finance dashboard with separate frontend files, an Express backend, local JSON data storage, and an AI finance chatbot.

## Features
- Monthly income, expense, cash-flow and savings-rate summary
- Add and delete transactions
- Spending category chart and six-month income/expense chart
- Monthly category budgets
- Savings goals and contributions
- Finance chatbot with a local fallback; optional OpenAI-powered responses
- Email/password signup and login with per-user transaction, budget and goal records
- Passwords stored as salted scrypt hashes; signed HttpOnly session cookie
- Export a JSON backup for the signed-in user

## Requirements
- Node.js 18+
- npm

## Run in VS Code (Ubuntu/Linux)
1. Extract this ZIP.
2. In VS Code, open the extracted `FinTrack_Organized` folder (File → Open Folder).
3. Open Terminal → New Terminal. Make sure the terminal is in this folder.
4. Run:

```bash
npm install
npm start
```

5. Open http://localhost:5000
6. Create an account with your name, email and a password of at least 8 characters, or log in with an existing account.

The app creates `data/fintrack.json` and a local session-signing secret automatically. MongoDB is not required. Each account's transactions, budgets and savings goals are tagged with its user ID and are only returned to that signed-in account. Existing records from the previous single-user version are assigned to the first account created after upgrading.

## Enable the optional AI chatbot
1. Copy `.env.example` to `.env`.
2. Add your own API key to `OPENAI_API_KEY`.
3. Restart the server.

Without an API key, the chatbot still works in local fallback mode and can answer basic questions based on the app's recorded income, expenses, budgets and goals. The API key stays on the server; never put it in `public/app.js` or commit `.env` to GitHub.

## Troubleshooting
- `Cannot find module 'express'`: run `npm install` in the project root.
- `Missing script: start`: confirm you opened this folder and that its `package.json` is present; run `npm run`.
- Port 5000 is busy: run `PORT=5001 npm start`, then open http://localhost:5001.
- Check server health at http://localhost:5000/api/health.

## Privacy and limitations
This is a local demo, not a bank-connected service. Do not enter bank passwords, UPI PINs, card PINs or OTPs. Passwords are stored as salted scrypt hashes, and the login session uses a signed HttpOnly cookie. Financial records are separated by account in a local JSON file, but the JSON file itself is not encrypted and this local demo is not a production-grade hosted service. Anyone with direct access to the computer and project data files may be able to inspect them. Chatbot responses are informational, not financial, tax or investment advice. There is no password-reset or email-verification flow in this version.


## Hybrid AI/ML engine

The dashboard exposes a Python scikit-learn service at `GET /api/ml/insights`. It is a hybrid system: trained ML models produce predictions, while budget suggestions remain transparent arithmetic rules.

### Models implemented
- **Expense-title categorisation:** TF-IDF text features + Logistic Regression classify transaction descriptions into the app's expense categories. The model starts with synthetic labelled descriptions and incorporates the signed-in user's labelled transaction titles when enough examples exist. It reports held-out synthetic accuracy and macro-F1, plus per-transaction predictions and confidence.
- **Expense forecasting:** Random Forest regression predicts next-month category totals using three monthly lags and income. It is evaluated against a three-month-average baseline on held-out synthetic users; the dashboard shows both MAEs. When a user has at least three months of records, their own monthly examples are included in the final fit and their latest three months are used for inference.
- **Unusual-spend screening:** Isolation Forest identifies transactions that differ from learned amount/category patterns. Flags are review prompts, not fraud determinations.
- **Spending segmentation:** KMeans groups category-share patterns. Cluster labels are descriptive, not financial advice.
- **Budget suggestions:** a recent personal average plus a 5% buffer. This is a rule, not an ML model.

### Install and run

```bash
npm install
python3 -m pip install -r ml/requirements.txt
cp .env.example .env   # optional: only if enabling OpenAI
npm start
```

Open `http://localhost:5000`, sign in, add expense transactions with meaningful titles and categories, then select **Run ML analysis**. For a personalised forecast, record at least three distinct months of transactions. To use a different Python executable, set `PYTHON_BIN` in `.env`.

### OpenAI and privacy

The server loads `.env` itself (Node 18 compatible). If `OPENAI_API_KEY` is configured, a chatbot request sends the current month's transaction records, budgets and savings goals for the signed-in account to the OpenAI API. Do not enable this if you do not want that data sent to an external provider. Without a key, the local keyword-based assistant is used. Never put API keys in frontend files or commit `.env`.

### Security and limitations

Passwords use salted scrypt hashes (asynchronous so hashing does not block the event loop). Login/signup attempts and chatbot requests have basic in-memory rate limits. Unsafe requests with a mismatched browser `Origin` are rejected; session cookies are HttpOnly and SameSite=Lax. Rate-limit counters reset when the server restarts and this is not a substitute for a production identity/security platform. The JSON database is local and unencrypted, and rewriting a JSON file is suitable only for a small local prototype. There is no bank/UPI integration, password reset, email verification, or production-grade multi-instance database.

Dates used for current-month calculations and new goal contributions use `Asia/Kolkata`; transaction dates are stored as date-only strings. Savings-goal contributions are also recorded as a `Savings` expense so they reduce the displayed spendable cash flow.

Classifier and forecasting metrics are evaluated on synthetic holdout data, not on your future personal spending. Synthetic descriptions are intentionally limited and results may not generalise to real merchant text. A strong academic evaluation should additionally collect a consented labelled dataset and report performance on a separate real-world test set. Forecasts can be unstable with short or irregular histories. Anomaly detection can produce false positives and false negatives. FinTrack is an educational prototype, not financial, tax, investment or fraud advice.

### Tests

```bash
node --check server.js
node --check public/app.js
python3 -m py_compile ml/ml_engine.py
python3 ml/tests/smoke_test.py
```

The smoke test runs the complete ML pipeline against a small example account dataset. Browser-based end-to-end testing is still required on the target machine.
