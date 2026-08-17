# cloud-penny — Lambda Deployment Guide

This project deploys your AWS Lambda functions and API Gateway routes automatically using **Terraform** and **GitHub Actions**.

---

## How It Works

```
You push code to GitHub
        │
        ├── Pull Request?  →  Terraform shows you a PLAN (what will change) as a PR comment
        │
        └── Merge to main? →  Terraform automatically APPLIES the changes to AWS
```

Every Lambda function is defined in one place: **`infra/functions.json`**

---

## Project Layout

```
cloud-penny/
│
├── functions/                          ← Your Lambda function code lives here
│   ├── cloud-penny-getClientMe/
│   │   └── index.mjs
│   ├── cloud-penny-deleteAccount/
│   │   └── index.mjs
│   ├── cloud-penny-getAwsConnection/
│   │   └── index.mjs
│   ├── cloud-penny-saveArn/
│   │   └── index.mjs
│   ├── cloud-penny-verifyArnRole/
│   │   └── index.mjs
│   └── cloud-penny-postConfirmationFunction/
│       └── index.mjs
│
├── infra/
│   └── functions.json                  ← THE config file — controls everything
│
├── .github/workflows/
│   ├── pr-plan.yml                     ← Runs on Pull Request
│   └── deploy.yml                      ← Runs on merge to main
│
├── scripts/
│   ├── zip-functions.js                ← Packages your code for deployment
│   ├── create-function.js              ← Scaffolds a new Lambda function
│   └── import-existing.js             ← Imports existing AWS resources into Terraform
│
└── bootstrap/
    └── bootstrap.sh                    ← One-time AWS setup (run once, ever)
```

---

## Before You Push for the First Time

You need to do these steps **once** on your local machine before pushing to GitHub.

---

### Step 1 — Install dependencies

```bash
npm install
```

---

### Step 2 — Create the Terraform state storage in AWS

This creates an S3 bucket and DynamoDB table so Terraform can safely store its state.

```bash
bash bootstrap/bootstrap.sh
```

When it finishes, it will print something like:

```
TF_STATE_BUCKET     = cloud-penny-terraform-state
TF_STATE_LOCK_TABLE = cloud-penny-terraform-locks
```

**Save these values** — you need them in Step 3.

---

### Step 3 — Add GitHub Secrets

Go to your GitHub repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add all 6 of these:

| Secret Name | What to put in it |
|---|---|
| `AWS_ACCESS_KEY_ID` | Your AWS IAM access key |
| `AWS_SECRET_ACCESS_KEY` | Your AWS IAM secret key |
| `AWS_REGION` | `ap-southeast-1` |
| `TF_STATE_BUCKET` | The bucket name from Step 2 |
| `TF_STATE_LOCK_TABLE` | The table name from Step 2 |
| `TF_STATE_KEY_PREFIX` | `cloud-penny` |

---

### Step 4 — Import your existing Lambda functions into Terraform

Your Lambda functions already exist in AWS. This step tells Terraform about them so it **manages** them instead of **recreating** them (which would break your endpoints).

**4a. Build the zip files:**
```bash
npm run zip
```

**4b. Initialise Terraform:**
```bash
terraform -chdir=infra init \
  -backend-config="bucket=cloud-penny-terraform-state" \
  -backend-config="key=cloud-penny/dev/terraform.tfstate" \
  -backend-config="region=ap-southeast-1" \
  -backend-config="dynamodb_table=cloud-penny-terraform-locks"
```
> Replace the bucket/table names with what `bootstrap.sh` printed in Step 2.

**4c. Generate and run the import commands:**
```bash
node scripts/import-existing.js dev
bash import.sh
```

This scans your AWS account, matches your existing functions, and imports them into Terraform state. You will see output like:

```
✅  cloud-penny-getClientMe        → imported
✅  cloud-penny-deleteAccount      → imported
✅  cloud-penny-getAwsConnection   → imported
...
```

**4d. Verify nothing will be destroyed:**
```bash
terraform -chdir=infra plan -var="environment=dev"
```

The output must say **0 to add, 0 to change, 0 to destroy** for all imported resources. If it does — you are ready to push.

---

### Step 5 — Push to GitHub

```bash
git add .
git commit -m "feat: add terraform pipeline"
git push origin main
```

This triggers the **deploy workflow** which automatically applies Terraform. Go to **GitHub → Actions** to watch it run.

---

## Day-to-Day Usage

### Updating a Lambda function

1. Edit the code in `functions/<function-name>/index.mjs`
2. Commit and push to `main`
3. GitHub Actions automatically zips + deploys it

```bash
git add functions/cloud-penny-getClientMe/index.mjs
git commit -m "fix: update getClientMe logic"
git push origin main
```

---

### Adding a brand new Lambda function

```bash
# 1. Scaffold the folder and auto-update functions.json
node scripts/create-function.js cloud-penny-myNewFunction

# 2. Write your logic
code functions/cloud-penny-myNewFunction/index.mjs

# 3. Open infra/functions.json and add the API route:
#    "routes": [{ "method": "POST", "path": "/api/v1/my-new-endpoint" }]

# 4. Push — GitHub Actions handles the deployment
git add .
git commit -m "feat: add cloud-penny-myNewFunction"
git push origin main
```

---

### Raising a Pull Request

When you open a PR targeting `main`, GitHub Actions automatically:
1. Runs `terraform plan`
2. Posts the plan output as a comment on your PR so you can see exactly what will change before merging

---

### Deploying to Production

Production is **manual** to prevent accidents.

Go to **GitHub → Actions → Terraform Deploy → Run workflow** → select `prod` → click **Run workflow**.

If you set up required reviewers under **Settings → Environments → prod**, someone must approve the deploy before it runs.

---

## Adding Routes to functions.json

Open `infra/functions.json`. Each function looks like this:

```json
{
  "name": "cloud-penny-getClientMe",
  "aws_name_override": "cloud-penny-getClientMe",
  "handler": "index.handler",
  "runtime": "nodejs20.x",
  "memory": 128,
  "timeout": 10,
  "environment": {
    "TENANTS_TABLE": "cloudpenny-tenants"
  },
  "routes": [
    { "method": "GET", "path": "/api/v1/clients/me" }
  ]
}
```

To add a new route to an existing function, just add to its `routes` array and push.  
To add a new function, add a new object to the array (or use `node scripts/create-function.js`).

---

## Current Functions and Routes

| Function | Route |
|---|---|
| `cloud-penny-getClientMe` | `GET /api/v1/clients/me` |
| `cloud-penny-deleteAccount` | `PUT /api/v1/clients/me`, `DELETE /api/v1/clients/me` |
| `cloud-penny-getAwsConnection` | `GET /api/v1/clients/aws-connection` |
| `cloud-penny-saveArn` | `POST /api/v1/clients/aws-connection` |
| `cloud-penny-verifyArnRole` | `POST /api/v1/clients/verify` |
| `cloud-penny-postConfirmationFunction` | *(Cognito trigger — no API route)* |

---

## Troubleshooting

**The GitHub Actions deploy fails on `terraform init`**
→ Check that all 6 GitHub secrets are set correctly (Step 3)

**Terraform says it will destroy a function I did not touch**
→ Run the import step again (Step 4c). The function is not yet in Terraform state.

**`npm run zip` says a folder was not found**
→ Make sure `functions/<function-name>/` exists with an `index.mjs` inside it.

**I deleted a function from `functions.json` and my endpoint broke**
→ Terraform will destroy the Lambda and its API route if you remove it from `functions.json`. To disable routing without deleting, set `"routes": []` instead.
