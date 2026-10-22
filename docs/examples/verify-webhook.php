<?php
// Verifica a assinatura de um webhook do SempreCRM. Sem dependências.
//
//   $raw = file_get_contents('php://input');            // bytes EXATOS recebidos
//   $ok = verifySempreCrmSignature($raw, $_SERVER['HTTP_SEMPRECRM_SIGNATURE'] ?? '', [getenv('WHSEC')]);
//
// $secrets: o segredo atual (e o antigo, durante uma rotação).
function verifySempreCrmSignature(string $rawBody, string $header, array $secrets, int $tolerance = 300, ?int $now = null): bool
{
    $now = $now ?? time();
    $t = null;
    $signatures = [];
    foreach (explode(',', $header) as $part) {
        $pair = explode('=', $part, 2);
        if (count($pair) !== 2) continue;
        [$k, $v] = [trim($pair[0]), trim($pair[1])];
        if ($k === 't' && ctype_digit($v)) $t = (int) $v;
        if ($k === 'v1') $signatures[] = $v;
    }
    if ($t === null || count($signatures) === 0) return false;
    if (abs($now - $t) > $tolerance) return false;

    foreach ($secrets as $secret) {
        $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
        foreach ($signatures as $sig) {
            if (hash_equals($expected, $sig)) return true;
        }
    }
    return false;
}
