<?php
declare(strict_types=1);

// Keep warnings out of JSON responses, including on local PHP installations.
ini_set('display_errors', '0');

// Public feedback is deliberately anonymous. Never return the private rate-limit data.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit;
}

function fail(int $status, string $message): void
{
    respond($status, ['error' => $message]);
}

function inputText(array $input, string $key, int $maximum): string
{
    if (!array_key_exists($key, $input)) {
        return '';
    }
    if (!is_string($input[$key])) {
        fail(422, ucfirst($key) . ' must be text.');
    }
    $value = trim($input[$key]);
    $length = preg_match_all('/./us', $value);
    if ($length === false || $length > $maximum) {
        fail(422, ucfirst($key) . ' must be ' . $maximum . ' characters or fewer.');
    }
    if (preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $value)) {
        fail(422, ucfirst($key) . ' contains unsupported characters.');
    }
    return $value;
}

function database(): PDO
{
    $configuredPath = getenv('BH_FEEDBACK_DB_PATH');
    $path = $configuredPath !== false && $configuredPath !== ''
        ? $configuredPath
        : dirname(__DIR__) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'feedback.sqlite';
    // Deployment overrides must be absolute, independent of Apache's working directory.
    $absolute = DIRECTORY_SEPARATOR === '\\'
        ? preg_match('~^(?:[A-Za-z]:[\\\\/]|[\\\\/]{2}[^\\\\/]+[\\\\/][^\\\\/]+[\\\\/])~', $path)
        : substr($path, 0, 1) === '/';
    if (!$absolute || strpos($path, "\0") !== false) {
        throw new RuntimeException('The feedback database path must be absolute.');
    }
    $directory = dirname($path);
    if (!is_dir($directory) && !mkdir($directory, 0750, true) && !is_dir($directory)) {
        throw new RuntimeException('Could not create the feedback storage directory.');
    }
    $db = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $db->exec('PRAGMA busy_timeout = 5000');
    $db->exec('PRAGMA journal_mode = WAL');
    $db->exec('CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment TEXT NOT NULL,
        suggestion TEXT NOT NULL,
        created_at TEXT NOT NULL
    )');
    $db->exec('CREATE TABLE IF NOT EXISTS rate_limit_events (
        client_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )');
    $db->exec('CREATE INDEX IF NOT EXISTS rate_limit_client_time ON rate_limit_events (client_hash, created_at)');
    $db->exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    $secret = $db->prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    $secret->execute(['rate_limit_salt', bin2hex(random_bytes(32))]);
    return $db;
}

function summary(PDO $db): array
{
    $distribution = array_fill(1, 5, 0);
    $count = 0;
    $total = 0;
    foreach ($db->query('SELECT rating, COUNT(*) AS count FROM feedback GROUP BY rating') as $row) {
        $rating = (int) $row['rating'];
        $distribution[$rating] = (int) $row['count'];
        $count += $distribution[$rating];
        $total += $rating * $distribution[$rating];
    }
    return [
        'count' => $count,
        'average' => $count ? round($total / $count, 2) : 0,
        'distribution' => (object) $distribution,
    ];
}

function review(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'name' => $row['name'],
        'rating' => (int) $row['rating'],
        'comment' => $row['comment'],
        'suggestion' => $row['suggestion'],
        'createdAt' => $row['created_at'],
    ];
}

function clientIp(): string
{
    // Enable only when Railway's HTTP edge is the exclusive public entry point.
    // Direct/local servers must not accept a visitor's claimed proxy address.
    $forwarded = $_SERVER['HTTP_X_REAL_IP'] ?? '';
    if (getenv('BH_FEEDBACK_TRUST_RAILWAY_PROXY') === '1'
        && filter_var($forwarded, FILTER_VALIDATE_IP) !== false) {
        return $forwarded;
    }
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

try {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'POST') {
        header('Allow: GET, POST');
        fail(405, 'This request method is not supported.');
    }

    if ($method === 'GET') {
        $offsetValue = $_GET['offset'] ?? '0';
        $limitValue = $_GET['limit'] ?? '6';
        if (!is_string($offsetValue) || !ctype_digit($offsetValue) || strlen($offsetValue) > 9
            || !is_string($limitValue) || !ctype_digit($limitValue) || (int) $limitValue < 1 || (int) $limitValue > 6) {
            fail(422, 'Use an offset of zero or more and a limit between 1 and 6.');
        }
        $offset = (int) $offsetValue;
        $limit = (int) $limitValue;
        $db = database();
        $db->beginTransaction();
        $totals = summary($db);
        $query = $db->prepare('SELECT id, name, rating, comment, suggestion, created_at FROM feedback ORDER BY id DESC LIMIT :limit OFFSET :offset');
        $query->bindValue(':limit', $limit, PDO::PARAM_INT);
        $query->bindValue(':offset', $offset, PDO::PARAM_INT);
        $query->execute();
        $reviews = array_map('review', $query->fetchAll());
        $db->commit();
        respond(200, [
            'summary' => $totals,
            'reviews' => $reviews,
            'hasMore' => $offset + count($reviews) < $totals['count'],
        ]);
    }

    if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') {
        fail(415, 'Send feedback as application/json.');
    }
    if (strtolower($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') {
        fail(403, 'Please submit feedback from this website.');
    }
    $raw = file_get_contents('php://input', false, null, 0, 16385);
    if ($raw === false || strlen($raw) > 16384) {
        fail(413, 'This feedback is too large.');
    }
    try {
        $inputObject = json_decode($raw, false, 16, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        fail(400, 'Send a valid JSON feedback object.');
    }
    if (!$inputObject instanceof stdClass) {
        fail(400, 'Send a valid JSON feedback object.');
    }
    $input = (array) $inputObject;
    if (!isset($input['rating']) || !is_int($input['rating']) || $input['rating'] < 1 || $input['rating'] > 5) {
        fail(422, 'Choose a rating from 1 to 5 stars.');
    }
    $name = inputText($input, 'name', 60);
    $comment = inputText($input, 'comment', 1000);
    $suggestion = inputText($input, 'suggestion', 1000);
    $website = inputText($input, 'website', 200);
    if ($website !== '') {
        fail(422, 'We could not accept this feedback.');
    }

    $db = database();
    $salt = $db->query("SELECT value FROM settings WHERE key = 'rate_limit_salt'")->fetchColumn();
    $clientHash = hash_hmac('sha256', clientIp(), (string) $salt);
    $now = time();
    $cutoff = $now - 600;
    // A write lock makes checking the limit and accepting feedback one atomic operation.
    $db->exec('BEGIN IMMEDIATE');
    $cleanup = $db->prepare('DELETE FROM rate_limit_events WHERE created_at <= ?');
    $cleanup->execute([$cutoff]);
    $recent = $db->prepare('SELECT COUNT(*) FROM rate_limit_events WHERE client_hash = ? AND created_at > ?');
    $recent->execute([$clientHash, $cutoff]);
    if ((int) $recent->fetchColumn() >= 5) {
        $db->exec('ROLLBACK');
        header('Retry-After: 600');
        fail(429, 'You have sent several ratings recently. Please try again in 10 minutes.');
    }
    $createdAt = gmdate('Y-m-d\TH:i:s\Z');
    $insert = $db->prepare('INSERT INTO feedback (name, rating, comment, suggestion, created_at) VALUES (?, ?, ?, ?, ?)');
    $insert->execute([$name, $input['rating'], $comment, $suggestion, $createdAt]);
    $id = (int) $db->lastInsertId();
    $event = $db->prepare('INSERT INTO rate_limit_events (client_hash, created_at) VALUES (?, ?)');
    $event->execute([$clientHash, $now]);
    $totals = summary($db);
    $db->exec('COMMIT');
    respond(201, [
        'review' => ['id' => $id, 'name' => $name, 'rating' => $input['rating'], 'comment' => $comment, 'suggestion' => $suggestion, 'createdAt' => $createdAt],
        'summary' => $totals,
    ]);
} catch (Throwable $error) {
    // Connection teardown rolls back any unfinished transaction.
    error_log('Feedback API error: ' . $error->getMessage());
    fail(503, 'Feedback is temporarily unavailable. Please try again later.');
}
