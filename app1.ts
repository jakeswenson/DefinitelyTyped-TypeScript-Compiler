var spawn = require('child_process').spawn;
var GitHubApi = require("node-github");
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var TypeScript = require('./nodets.js');


function getDownloadFolder(user) { return path.join(__dirname, '../definitelyTypedFiles', user); }
function getStatusFile(user) { return path.join(getDownloadFolder(user), 'status.json') }
function getTreeFile(user) { return path.join(getDownloadFolder(user), 'tree.json'); }

var typescript = path.join(__dirname, '../typescript/built/local/tsc.js');
var libdts = path.join(__dirname, 'lib.d.ts');
var libdtsText = fs.readFileSync(libdts);

// only get 5000 request a day, if this becomes an issue get your own token.
var gitHubAuthToken = 'cc6e134f1a93c61f30a2bd92fede31ad88109fcf';
var gitHubAuth = {
    type: "oauth",
    token: gitHubAuthToken
};

var gitHubOpts = {
    version: "3.0.0",
    timeout: 5000
};

function createGitHub() {
    var github = new GitHubApi(gitHubOpts);
    github.authenticate(gitHubAuth);
    return github;
}

var compilationList = {
    users: ['borisyankov', 'guiserrato'],
    repo: 'DefinitelyTyped'
};

var userCount = compilationList.users.length;
var defaultUser = 'borisyankov';

function getCompiler() {
    var Logger = (function () {
        function Logger() {
        }
        Logger.prototype.log = function (msg) {
            console.log(msg);
        };
        Logger.prototype.information = function () {
            return true;
        };
        Logger.prototype.debug = function () {
            return true;
        };
        Logger.prototype.warning = function () {
            return true;
        };
        Logger.prototype.error = function () {
            return true;
        };
        Logger.prototype.fatal = function () {
            return true;
        };
        return Logger;
    })();

    var settings = new TypeScript.CompilationSettings();

    var compiler = new TypeScript.TypeScriptCompiler(new Logger(), TypeScript.ImmutableCompilationSettings.fromCompilationSettings(settings));

    //compiler.addFile(libdts, TypeScript.ScriptSnapshot.fromString(libdtsText.toString()), TypeScript.ByteOrderMark.None, 1, true, function(file) { throw file; });

    return compiler;
}

function addFile(compiler, fileName, callback) {
    console.log('Adding file', fileName, 'to compiler')
    fs.readFile(fileName, function (err, fileData) {
        var scriptSnapshot = TypeScript.ScriptSnapshot.fromString(fileData.toString());
        compiler.addFile(fileName, scriptSnapshot, TypeScript.ByteOrderMark.None, 1, true, function (file) { throw file; });
        callback(compiler);
    });
}

function runCompiler(compiler, fileName, callback) {
    setTimeout(function () {
        console.log('getting diagnostics for', fileName)
        var syntaxDiag = compiler.getSyntacticDiagnostics(fileName);
        var semanticDiag = compiler.getSemanticDiagnostics(fileName);
        var errors = syntaxDiag.concat(semanticDiag).map(function (diag) { return diag.message() + "\r\n"; });
        callback({
            error: errors,
            exitCode: errors.length,
            out: []
        });
    }, 1);
}

function getTypeScriptCompiler(files, callback) {
    var compiler = getCompiler();
    var filesCopy = files.slice();

    function addFiles(finished) {
        if (filesCopy.length) {
            addFile(compiler, filesCopy.pop(), addFiles.bind(null, finished));
        }
        else {
            finished();
        }
    }

    addFiles(function () {
        console.log('added all files');
        callback(runCompiler.bind(null, compiler));
    });
}

function getNodeRunner(files, callback) {
    callback(function (file, callback) {
        console.log('compiling', file)
        var output = { out: [], error: [], exitCode: -1 };
        var compiler = spawn('node', [typescript, file])
        compiler.stdout.on('data', function (data) {
            output.out.push(data.toStriong());
        });

        compiler.stderr.on('data', function (data) {
            output.error.push(data.toString());
        });

        compiler.on('close', function (code) {
            output.exitCode = code;
            callback(output);
        });
    });
}

function compile(user, files, runData) {
    var compileResults = {};
    var compilationState = {
        lastGitHubUpdate: runData.updatedAt,
        lastCommit: runData.lastCommit,
        compileStart: new Date(),
        compileResults: compileResults
    };

    var compilerFactory = getTypeScriptCompiler;

    console.log('Starting compile for', user);

    function writeCompilationResults() {
        var compileEnd = new Date();
        compilationState.compileEnd = compileEnd;

        console.log(user, 'compile done!!');

        var folderPath = path.join(__dirname, '../definitelyTyped/', user);

        fs.mkdir(folderPath, function () {
            var filePath = path.join(__dirname, '../definitelyTyped/', user, 'results.json');

            if (user === defaultUser) {
                filePath = path.join(__dirname, '../definitelyTyped/', 'results.json')
            }

            fs.writeFile(filePath, JSON.stringify(compilationState), function () {
                console.log(user, 'result file written to:', filePath);
            })
        });
    }

    compilerFactory(files, function (compiler) {

        function compileOne(file, finish) {
            compiler(file, function (output) {
                compileResults[file] = output;

                if (files.length > 0) {
                    var nextFile = files.pop();
                    compileOne(nextFile, finish);
                }
                else {
                    finish();
                }
            });
        }

        compileOne(files.pop(), writeCompilationResults);
    });

}

function finishDownload(user, lastCommit, lastUpdate, compilerFiles) {
    console.log('done getting files');

    var runData = {
        lastCommit: lastCommit,
        updatedAt: lastUpdate,
        files: compilerFiles
    };

    fs.writeFile(getStatusFile(user), JSON.stringify(runData), function (err) {
        if (err) { throw err; }
        setTimeout(function () {
            compile(user, compilerFiles, runData);
        }, 1);
    })
}

function processBlob(user, repo, latestCommit, lastUpdatedAt, file, files, compilerFiles) {
    if (!file || !file.path) {
        console.log('File has no path', JSON.stringify(file), files.length)
        return;
    }

    var github = createGitHub();

    var outputFile = path.join(getDownloadFolder(user), file.path);

    function processNext() {
        compilerFiles.push(outputFile);
        if (files.length === 0) {
            finishDownload(user, latestCommit, lastUpdatedAt, compilerFiles);
        }
        else {
            processBlob(user, repo, latestCommit, lastUpdatedAt, files.pop(), files, compilerFiles);
        }
    }

    function fileChanged(fileName, sha, result) {
        fs.exists(fileName, function (exists) {
            if (!exists) {
                result(true);
                return;
            }

            fs.readFile(fileName, function (err, data) {
                if (err) { throw err; }
                var hasher = crypto.createHash('sha1');
                hasher.update(data);
                var hash = hasher.digest('hex');
                var hasChanged = sha !== hash;
                //console.log('file', fileName, 'has changed', hasChanged);
                result(hasChanged);
            });
        });
    }

    // can't trust file.sha, its not the file's sha...
    fileChanged(outputFile, file.sha, function (changed) {

        if (!changed) {
            processNext();
            return;
        }

        github.gitdata.getBlob({
            user: user,
            repo: repo,
            sha: file.sha,
        },
            function (err, blob) {
                if (err) {
                    console.error('error with file ', file.path, 'error:', err);
                    if (files.length === 0) { console.log('done'); }
                    return;
                }
                else if (blob.size !== file.size || blob.sha !== file.sha) {
                    console.log('blob sha', blob.sha);
                    console.warn('File Size mismatch: ', file.size, blob.size, blob.url, file.url)
                return;
                }

                console.log('Writing file contents', outputFile, '-', blob.size);
                console.log('remaining:', files.length, 'api calls left:', blob.meta['x-ratelimit-remaining']);

                fs.writeFile(outputFile, new Buffer(blob.content, 'base64'), function () {
                    processNext();
                });
            });
    });
}

function processTree(github, info, latestCommit, lastUpdatedAt) {
    github.gitdata.getTree({
        user: info.user,
        repo: info.repo,
        sha: latestCommit,
        recursive: true
    },
        function (err, tree) {
            if (err) {
                console.error('error:', err);
                throw err;
            }

            fs.mkdir(getDownloadFolder(info.user), function () {

                fs.writeFile(getTreeFile(info.user), JSON.stringify(tree), function (err) { if (err) { throw err; } })

            var dtsFiles = tree.tree.filter(function (file) {
                    return file.type === "blob" &&
                        /\.d\.ts$/.test(file.path) &&
                        !/^_/.test(file.path);
                });

                console.log('processing tree .d.ts files:', dtsFiles.length, tree.url);

                var files = [];
                var makeDirCount = dtsFiles.length;

                function startProcessingBlobs() {
                    processBlob(info.user, info.repo, latestCommit, lastUpdatedAt, files.pop(), files, []);
                }

                function madeDir() {
                    if (--makeDirCount === 0) {
                        startProcessingBlobs();
                    }
                }

                dtsFiles.forEach(function (file) {
                    var outputDir = path.join(getDownloadFolder(info.user), path.dirname(file.path));
                    files.push(file);

                    if (!fs.existsSync(outputDir)) {
                        console.log('makingdir: ', outputDir, 'exists:', exists);
                        fs.mkdirSync(outputDir);
                        madeDir()
                }
                    else {
                        madeDir();
                    }
                });
            });
        });
}

function processCommits(github, info, lastUpdatedAt) {
    github.repos.getCommits({
        user: info.user,
        repo: info.repo,
        per_page: 1
    },
        function (err, commits) {
            if (err) {
                console.error('error:', err);
                return;
            }

            var latestCommit = commits[0].sha;
            console.log(info.user, info.repo, 'most recent commit', latestCommit);

            var statusFile = getStatusFile(info.user);

            fs.exists(statusFile, function (exists) {
                if (exists) {
                    fs.readFile(statusFile, function (err, fileJSON) {
                        if (err) { throw err; }
                        var lastRunData = JSON.parse(fileJSON);
                        if (lastRunData.lastCommit === latestCommit) {
                            console.log(info.user, 'Last commit is latest, recompiling');
                            setTimeout(function () { compile(info.user, lastRunData.files, lastRunData); }, 1);
                            return;
                        }
                        else {
                            console.log(info.user, 'latest commit', latestCommit, 'last processed', lastRunData.lastCommit);
                        }

                        processTree(github, info, latestCommit, lastUpdatedAt);
                    });
                    return;
                }

                processTree(github, info, latestCommit, lastUpdatedAt);
            })
    });
}


function processRepo(github, user, repo) {
    var info = { user: user, repo: repo };

    github.repos.get(info, function (err, repoInfo) {
        if (err) {
            console.error('error:', err);
            throw err;
        }

        var lastUpdatedAt = new Date(repoInfo.updated_at);
        console.log(user, repo, "updated at:", lastUpdatedAt);

        processCommits(github, info, lastUpdatedAt);
    });
}

compilationList.users.forEach(function (user) {
    console.log('Processing repository "', compilationList.repo, '" for user', user);
    processRepo(createGitHub(), user, compilationList.repo)
}); 