set -e

# Definitely don't print this command
set +xv
export GMAIL_APP_PASSWORD="$(gcloud secrets versions access latest --secret=gmail-app-password --project=gcmn-salvage-scraper)"
