param([Parameter(Mandatory=$true)][string]$Package,[Parameter(Mandatory=$true)][string]$Signature)
$ErrorActionPreference='Stop'
$rsa=[Security.Cryptography.RSA]::Create(2048)
$certificate=$null
try {
  $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=DreamFlutter T67 temporary test',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $certificate=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(2))
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $hash=([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Package)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  $signed=$rsa.SignData([Text.Encoding]::ASCII.GetBytes($hash),[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $pem="-----BEGIN CERTIFICATE-----`n"+[Convert]::ToBase64String($certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert),[Base64FormattingOptions]::InsertLineBreaks)+"`n-----END CERTIFICATE-----"
  [IO.File]::WriteAllText($Signature,(@{algorithm='RSA-SHA256';certificate=$pem;signature=[Convert]::ToBase64String($signed)} | ConvertTo-Json))
} finally { if($certificate){$certificate.Dispose()}; $rsa.Dispose() }
