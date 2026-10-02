# Takes AWS account IDs out of text bound for a public log or job summary (the deploy workflow's
# cdk diff): every run of exactly 12 digits becomes <account>. It over-redacts on purpose (any
# 12-digit number goes), so account IDs inside Fn::Join pieces, bare principals and other
# accounts' ARNs go too. Twice, because one match uses up the character between two IDs.
#   sed -E -f scripts/scrub-account-ids.sed
s/(^|[^0-9])[0-9]{12}([^0-9]|$)/\1<account>\2/g
s/(^|[^0-9])[0-9]{12}([^0-9]|$)/\1<account>\2/g
