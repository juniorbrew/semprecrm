# ============================================================
# Baixa para este computador os backups CIFRADOS (*.age) da VPS do
# SempreCRM. Roda agendado (ver o README da pasta deploy/contabo).
#
# - Só copia arquivos *.age (cifrados com a chave pública age). A chave
#   privada nunca vai para a VPS; sem ela os arquivos são ilegíveis.
# - Baixa só o que ainda não tem (arquivo .part até terminar).
# - Apaga daqui os .age com mais de $ManterDias dias.
# - Sai com código 1 (erro) ou 2 (backup da VPS atrasado) e registra
#   tudo em pull.log, para o Agendador de Tarefas mostrar a falha.
# ============================================================
param(
  [string]$Destino = (Join-Path $env:USERPROFILE 'SempreCRM-backups\arquivos'),
  [int]$ManterDias = 60,
  [string]$Servidor = 'semprecrm',
  [string]$PastaRemota = '/var/backups/semprecrm',
  [int]$AtrasoMaxHoras = 30
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Destino | Out-Null
$log = Join-Path (Split-Path $Destino -Parent) 'pull.log'
function Log([string]$m) { $linha = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Add-Content -Path $log -Value $linha; Write-Host $linha }

# Lista os .age com a data (epoch) de cada um, sem baixar nada.
$lista = & ssh -o BatchMode=yes -o ConnectTimeout=20 $Servidor "find '$PastaRemota' -maxdepth 1 -type f -name '*.age' -printf '%T@ %f\n'"
if ($LASTEXITCODE -ne 0) { Log 'ERRO: não consegui listar os backups na VPS (sem rede ou SSH?)'; exit 1 }
$remotos = @($lista | Where-Object { $_ } | ForEach-Object {
  $p = $_ -split ' ', 2
  [pscustomobject]@{ Nome = $p[1]; Data = [DateTimeOffset]::FromUnixTimeSeconds([int64][double]$p[0]).LocalDateTime }
})
if ($remotos.Count -eq 0) { Log 'AVISO: nenhum backup cifrado (*.age) na VPS — a cifragem está ativa em /etc/semprecrm/backup.env?'; exit 2 }

$novos = 0
foreach ($r in $remotos) {
  $final = Join-Path $Destino $r.Nome
  if (Test-Path $final) { continue }
  $parcial = "$final.part"
  & scp -q -o BatchMode=yes "${Servidor}:$PastaRemota/$($r.Nome)" $parcial
  if ($LASTEXITCODE -ne 0) { Remove-Item $parcial -ErrorAction SilentlyContinue; Log "ERRO ao baixar $($r.Nome)"; exit 1 }
  Move-Item -Force $parcial $final
  (Get-Item $final).LastWriteTime = $r.Data
  $novos++
  Log "baixado $($r.Nome) ($([math]::Round((Get-Item $final).Length / 1KB)) KB)"
}

Get-ChildItem -Path $Destino -Filter '*.age' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$ManterDias) } |
  ForEach-Object { Remove-Item $_.FullName; Log "removido (mais de $ManterDias dias) $($_.Name)" }

$ultimoDb = $remotos | Where-Object { $_.Nome -like 'db_*' } | Sort-Object Data -Descending | Select-Object -First 1
if (-not $ultimoDb -or $ultimoDb.Data -lt (Get-Date).AddHours(-$AtrasoMaxHoras)) {
  Log "AVISO: o dump do banco mais novo na VPS tem mais de $AtrasoMaxHoras h — o backup noturno falhou?"
  exit 2
}
Log "ok: $novos novo(s); último dump do banco $($ultimoDb.Nome)"
exit 0
