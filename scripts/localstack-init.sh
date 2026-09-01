#!/bin/sh
set -eu

awslocal s3api create-bucket --bucket trustpay-evidence >/dev/null 2>&1 || true
awslocal s3api put-public-access-block \
  --bucket trustpay-evidence \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
awslocal s3api put-bucket-encryption \
  --bucket trustpay-evidence \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
