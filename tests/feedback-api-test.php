<?php
declare(strict_types=1);

// Exercises the real HTTP API against an isolated database, never the site's feedback.
$root = dirname(__DIR__);
$temporary = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'bh-feedback-test-' . bin2hex(random_bytes(8));
mkdir($temporary, 0700);
$databasePath = $temporary . DIRECTORY_SEPARATOR . 'feedback.sqlite';
$environment = getenv();
$environment['BH_FEEDBACK_DB_PATH'] = $databasePath;
$environment['BH_FEEDBACK_TRUST_RAILWAY_PROXY'] = '0';
$socket = stream_socket_server('tcp://127.0.0.1:0', $errorNumber, $errorMessage);
if ($socket === false) {
    throw new RuntimeException('Could not choose a local test port.');
}
$address = stream_socket_get_name($socket, false);
fclose($socket);
$base = 'http://' . $address . '/api/feedback.php';
$process = null;
$secondaryProcess = null;
$checks = 0;

function check(bool $condition, string $message): void
{
    global $checks;
    if (!$condition) {
        throw new RuntimeException($message);
    }
    $checks++;
}

function request(string $method = 'GET', ?string $body = null, array $headers = [], string $query = ''): array
{
    global $base;
    if ($body !== null && !isset($headers['Content-Type'])) {
        $headers['Content-Type'] = 'application/json';
    }
    $headerLines = [];
    foreach ($headers as $key => $value) {
        $headerLines[] = $key . ': ' . $value;
    }
    $context = stream_context_create(['http' => [
        'method' => $method,
        'content' => $body ?? '',
        'header' => implode("\r\n", $headerLines),
        'ignore_errors' => true,
        'timeout' => 3,
    ]]);
    $raw = @file_get_contents($base . $query, false, $context);
    if ($raw === false) {
        return [0, null, []];
    }
    preg_match('/\s(\d{3})\s/', $http_response_header[0], $matches);
    return [(int) $matches[1], json_decode($raw, true, 512, JSON_THROW_ON_ERROR), $http_response_header];
}

function launchServer(string $listenAddress, string $logName)
{
    global $root, $temporary, $environment;
    $server = proc_open([PHP_BINARY, '-d', 'display_errors=0', '-S', $listenAddress, '-t', $root, $root . DIRECTORY_SEPARATOR . 'dev-router.php'], [
        0 => ['pipe', 'r'],
        1 => ['file', $temporary . DIRECTORY_SEPARATOR . $logName, 'a'],
        2 => ['file', $temporary . DIRECTORY_SEPARATOR . $logName, 'a'],
    ], $pipes, $root, $environment);
    if (!is_resource($server)) {
        throw new RuntimeException('Could not start the PHP test server.');
    }
    fclose($pipes[0]);
    return $server;
}

function startServer(): void
{
    global $process, $address;
    $process = launchServer($address, 'server.log');
    for ($attempt = 0; $attempt < 50; $attempt++) {
        if (request()[0] === 200) {
            return;
        }
        usleep(100000);
    }
    throw new RuntimeException('The PHP test server did not become ready.');
}

function stopServer(): void
{
    global $process;
    if (is_resource($process)) {
        proc_terminate($process);
        proc_close($process);
        $process = null;
    }
}

$exitCode = 0;
try {
    startServer();
    foreach (['/storage/.htaccess', '/storage/feedback.sqlite', '/.git/config', '/docker/start.sh', '/tests/feedback-api-test.php'] as $path) {
        $context = stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => 3]]);
        $raw = file_get_contents('http://' . $address . $path, false, $context);
        check(strpos($http_response_header[0], ' 404 ') !== false && $raw === 'Not found', 'Private path blocked: ' . $path);
    }
    foreach (['/' => '<!DOCTYPE html>', '/style.css' => '.container', '/feedback.js' => 'feedback-form'] as $path => $expected) {
        $raw = file_get_contents('http://' . $address . $path);
        check(strpos($http_response_header[0], ' 200 ') !== false && strpos($raw, $expected) !== false, 'Public asset served: ' . $path);
    }
    [$status, $data] = request();
    check($status === 200 && $data['summary']['count'] === 0 && $data['summary']['average'] === 0, 'Empty summary');
    check($data['reviews'] === [] && !$data['hasMore'], 'Empty reviews');
    check(array_values($data['summary']['distribution']) === [0, 0, 0, 0, 0], 'Empty distribution');

    foreach (['{}', '{"rating":"5"}', '{"rating":5.0}', '{"rating":0}', '{"rating":6}', '{"rating":true}', '{"rating":5,"comment":null}'] as $invalid) {
        check(request('POST', $invalid)[0] === 422, 'Invalid field rejection: ' . $invalid);
    }
    foreach (['[]', 'null', '{broken'] as $invalid) {
        check(request('POST', $invalid)[0] === 400, 'Invalid JSON object rejection');
    }
    check(request('POST', '{"rating":5}', ['Content-Type' => 'text/plain'])[0] === 415, 'Non-JSON rejection');
    check(request('POST', '{"rating":5}', ['Sec-Fetch-Site' => 'cross-site'])[0] === 403, 'Cross-site rejection');
    check(request('POST', str_repeat('x', 16385))[0] === 413, 'Oversized request rejection');
    check(request('POST', '{"rating":5,"website":"bot.example"}')[0] === 422, 'Honeypot rejection');
    check(request('POST', json_encode(['rating' => 5, 'name' => str_repeat('é', 61)]))[0] === 422, 'Unicode name limit');
    check(request('POST', json_encode(['rating' => 5, 'comment' => str_repeat('x', 1001)]))[0] === 422, 'Comment limit');
    check(request('POST', json_encode(['rating' => 5, 'suggestion' => str_repeat('x', 1001)]))[0] === 422, 'Suggestion limit');
    check(request('GET', null, [], '?offset=-1')[0] === 422, 'Invalid offset');
    check(request('GET', null, [], '?offset[]=1')[0] === 422, 'Array offset');
    check(request('GET', null, [], '?limit=7')[0] === 422, 'Invalid limit');
    check(request('DELETE')[0] === 405, 'Unsupported method');

    [$status, $data] = request('POST', '{"rating":5}', ['X-Real-IP' => '203.0.113.10']);
    check($status === 201 && $data['review']['rating'] === 5 && $data['review']['name'] === '', 'Rating-only submission');
    $text = '<script>alert("unsafe")</script> 😊';
    [$status, $data] = request('POST', json_encode(['rating' => 1, 'name' => "O'Reilly", 'comment' => $text, 'suggestion' => 'Add quizzes.']));
    check($status === 201 && $data['review']['comment'] === $text && $data['review']['name'] === "O'Reilly", 'Plain text and prepared SQL');
    check((bool) preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $data['review']['createdAt']), 'UTC timestamp');
    foreach ([2, 3, 4] as $rating) {
        check(request('POST', json_encode(['rating' => $rating]))[0] === 201, 'Additional rating');
    }
    [$status, $data, $headers] = request('POST', '{"rating":5}');
    check($status === 429 && in_array('Retry-After: 600', $headers, true), 'Rate limit');
    [$status, $data] = request('GET', null, [], '?limit=2&offset=0');
    check($status === 200 && $data['summary']['count'] === 5 && $data['summary']['average'] == 3, 'Aggregate summary');
    check(array_values($data['summary']['distribution']) === [1, 1, 1, 1, 1], 'Aggregate distribution');
    check(array_column($data['reviews'], 'rating') === [4, 3] && $data['hasMore'], 'Newest-first pagination');
    [$status, $data] = request('GET', null, [], '?limit=2&offset=4');
    check(count($data['reviews']) === 1 && $data['reviews'][0]['rating'] === 5 && !$data['hasMore'], 'Final page');
    check(is_file($databasePath), 'Isolated persistent database');

    stopServer();
    startServer();
    check(request()[1]['summary']['count'] === 5, 'Persistence after server restart');
    $db = new PDO('sqlite:' . $databasePath);
    $hashes = $db->query('SELECT DISTINCT client_hash FROM rate_limit_events')->fetchAll(PDO::FETCH_COLUMN);
    check(count($hashes) === 1 && preg_match('/^[a-f0-9]{64}$/', $hashes[0]) === 1 && $hashes[0] !== hash('sha256', '127.0.0.1'), 'Salted IP hashes; proxy header ignored by default');
    $db->exec('UPDATE rate_limit_events SET created_at = ' . (time() - 601));
    $db = null;
    check(request('POST', '{"rating":5}')[0] === 201, 'Rate limit expires');

    // Railway opt-in separates real visitors; direct mode above ignored the header.
    stopServer();
    $environment['BH_FEEDBACK_TRUST_RAILWAY_PROXY'] = '1';
    startServer();
    for ($submission = 0; $submission < 5; $submission++) {
        check(request('POST', '{"rating":5}', ['X-Real-IP' => '203.0.113.10'])[0] === 201, 'Trusted proxy visitor');
    }
    check(request('POST', '{"rating":5}', ['X-Real-IP' => '203.0.113.10'])[0] === 429, 'Trusted visitor rate limit');
    check(request('POST', '{"rating":4}', ['X-Real-IP' => '2001:db8::1'])[0] === 201, 'Another trusted IPv6 visitor');
    check(request('POST', '{"rating":3}', ['X-Real-IP' => 'not-an-ip'])[0] === 201, 'Malformed proxy header fallback');
    $db = new PDO('sqlite:' . $databasePath);
    $salt = $db->query("SELECT value FROM settings WHERE key = 'rate_limit_salt'")->fetchColumn();
    $hashes = $db->query('SELECT DISTINCT client_hash FROM rate_limit_events')->fetchAll(PDO::FETCH_COLUMN);
    check(count($hashes) === 3 && in_array(hash_hmac('sha256', '127.0.0.1', $salt), $hashes, true), 'Trusted hashes and malformed fallback');
    $db = null;

    if (extension_loaded('curl')) {
        // Two PHP processes provide real concurrent SQLite access on Windows too.
        $socket = stream_socket_server('tcp://127.0.0.1:0', $errorNumber, $errorMessage);
        if ($socket === false) {
            throw new RuntimeException('Could not choose a second test port.');
        }
        $secondAddress = stream_socket_get_name($socket, false);
        fclose($socket);
        $secondaryProcess = launchServer($secondAddress, 'server2.log');
        $secondBase = 'http://' . $secondAddress . '/api/feedback.php';
        $ready = false;
        for ($attempt = 0; $attempt < 50; $attempt++) {
            if (@file_get_contents($secondBase) !== false) {
                $ready = true;
                break;
            }
            usleep(100000);
        }
        check($ready, 'Second concurrent server ready');
        $beforeCount = request()[1]['summary']['count'];
        $multi = curl_multi_init();
        $requests = [];
        for ($submission = 0; $submission < 8; $submission++) {
            $handle = curl_init($submission % 2 ? $secondBase : $base);
            curl_setopt_array($handle, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => '{"rating":5}',
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Real-IP: 198.51.100.77'],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 15,
            ]);
            curl_multi_add_handle($multi, $handle);
            $requests[] = $handle;
        }
        do {
            $result = curl_multi_exec($multi, $running);
            if ($running && curl_multi_select($multi, 0.5) === -1) {
                usleep(1000);
            }
        } while ($running && $result === CURLM_OK);
        $statuses = [];
        foreach ($requests as $handle) {
            $statuses[] = curl_getinfo($handle, CURLINFO_HTTP_CODE);
            json_decode(curl_multi_getcontent($handle), true, 512, JSON_THROW_ON_ERROR);
            curl_multi_remove_handle($multi, $handle);
            curl_close($handle);
        }
        curl_multi_close($multi);
        sort($statuses);
        check($statuses === [201, 201, 201, 201, 201, 429, 429, 429], 'Atomic concurrent submission limit');
        check(request()[1]['summary']['count'] === $beforeCount + 5, 'All concurrent accepted ratings persisted');
        proc_terminate($secondaryProcess);
        proc_close($secondaryProcess);
        $secondaryProcess = null;
    } else {
        echo "SKIP: Concurrent HTTP check requires optional PHP curl extension.\n";
    }
    echo 'PASS: ' . $checks . " feedback API checks; isolated database removed.\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'FAIL: ' . $error->getMessage() . "\n");
    if (is_file($temporary . DIRECTORY_SEPARATOR . 'server.log')) {
        fwrite(STDERR, file_get_contents($temporary . DIRECTORY_SEPARATOR . 'server.log'));
    }
    $exitCode = 1;
} finally {
    stopServer();
    if (is_resource($secondaryProcess)) {
        proc_terminate($secondaryProcess);
        proc_close($secondaryProcess);
    }
    foreach (glob($temporary . DIRECTORY_SEPARATOR . '*') as $file) {
        unlink($file);
    }
    rmdir($temporary);
}
exit($exitCode);
