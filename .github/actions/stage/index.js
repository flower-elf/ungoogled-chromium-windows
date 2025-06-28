// 请用这个版本替换你的 Action 源码
const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const {DefaultArtifactClient} = require('@actions/artifact');
const glob = require('@actions/glob');

async function run() {
    process.on('SIGINT', function() {
        console.log("Caught SIGINT. The process will attempt to save artifacts and exit gracefully.");
    })
    
    // ... (之前的输入和 artifact 准备代码保持不变) ...
    const finished = core.getBooleanInput('finished', {required: true});
    const from_artifact = core.getBooleanInput('from_artifact', {required: true});
    const x86 = core.getBooleanInput('x86', {required: false})
    const arm = core.getBooleanInput('arm', {required: false})
    console.log(`finished: ${finished}, artifact: ${from_artifact}`);
    if (finished) {
        core.setOutput('finished', true);
        return;
    }

    const artifact = new DefaultArtifactClient();
    const artifactName = x86 ? 'build-artifact-x86' : (arm ? 'build-artifact-arm' : 'build-artifact');

    if (from_artifact) {
        const artifactInfo = await artifact.getArtifact(artifactName);
        await artifact.downloadArtifact(artifactInfo.artifact.id, {path: 'C:\\ungoogled-chromium-windows\\build'});
        await exec.exec('7z', ['x', 'C:\\ungoogled-chromium-windows\\build\\artifacts.zip',
            '-oC:\\ungoogled-chromium-windows\\build', '-y']);
        await io.rmRF('C:\\ungoogled-chromium-windows\\build\\artifacts.zip');
    }

    const args = ['build.py', '--ci']
    if (x86)
        args.push('--x86')
    if (arm)
        args.push('--arm')
    await exec.exec('python', ['-m', 'pip', 'install', 'httplib2'], {
        cwd: 'C:\\ungoogled-chromium-windows',
        ignoreReturnCode: true
    });
    
    const retCode = await exec.exec('python', args, {
        cwd: 'C:\\ungoogled-chromium-windows',
        ignoreReturnCode: true
    });

    const isTimeoutOrCancel = (retCode !== 0 && retCode !== 1);
    const isPatchOrBuildFailure = (retCode === 1);

    if (isPatchOrBuildFailure) {
        // --- 新的、轻量级的失败逻辑 ---
        console.error(`Build script failed with exit code ${retCode}. This is likely a build or patch error.`);
        console.log("Attempting to upload .rej files for debugging...");

        // 查找所有 .rej 和 .orig 文件
        const globber = await glob.create('C:\\ungoogled-chromium-windows\\build\\src\\**\\*.rej',
            {matchDirectories: false, followSymbolicLinks: false});
        let rejectFiles = await globber.glob();
        
        if (rejectFiles.length > 0) {
            console.log(`Found reject files: ${rejectFiles.join(', ')}`);
            try {
                // 上传找到的 .rej 文件
                await artifact.uploadArtifact(
                    `patch-rejects-${github.run_id}-${github.job}`, // 唯一的 artifact 名称
                    rejectFiles, 
                    'C:\\ungoogled-chromium-windows\\build\\src', // 根目录
                    {retentionDays: 1}
                );
                console.log(".rej files uploaded successfully.");
            } catch (e) {
                console.error(`Failed to upload .rej files: ${e.message}`);
            }
        } else {
            console.log("No .rej files found. The failure might be due to other build errors.");
        }
        
        // 关键：明确地让步骤失败
        core.setFailed(`Build script failed with a specific build error (exit code ${retCode}). Check logs for details.`);

    } else if (isTimeoutOrCancel) {
        // --- 保留原有的超时逻辑 ---
        console.log(`Build script exited with code ${retCode}, indicating a timeout or cancellation. Saving progress...`);
        
        // 打包并上传整个 src 目录
        await new Promise(r => setTimeout(r, 5000));
        await exec.exec('7z', ['a', '-tzip', 'C:\\ungoogled-chromium-windows\\artifacts.zip',
            'C:\\ungoogled-chromium-windows\\build\\src', '-mx=3', '-mtc=on'], {ignoreReturnCode: true});
        for (let i = 0; i < 5; ++i) {
            try {
                await artifact.deleteArtifact(artifactName);
            } catch (e) { /* ignored */ }
            try {
                await artifact.uploadArtifact(artifactName, ['C:\\ungoogled-chromium-windows\\artifacts.zip'],
                    'C:\\ungoogled-chromium-windows', {retentionDays: 1, compressionLevel: 0});
                break;
            } catch (e) {
                console.error(`Upload artifact failed: ${e}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }

        // 让步骤成功，以便工作流继续
        console.log("Progress saved successfully after timeout/cancellation. The job will continue.");
        core.setOutput('finished', false);

    } else { // retCode === 0
        // --- 成功的逻辑保持不变 ---
        core.setOutput('finished', true);
        const globber = await glob.create('C:\\ungoogled-chromium-windows\\build\\ungoogled-chromium*',
            {matchDirectories: false});
        let packageList = await globber.glob();
        const finalArtifactName = x86 ? 'chromium-x86' : (arm ? 'chromium-arm' : 'chromium');
        for (let i = 0; i < 5; ++i) {
            try {
                await artifact.deleteArtifact(finalArtifactName);
            } catch (e) { /* ignored */ }
            try {
                await artifact.uploadArtifact(finalArtifactName, packageList,
                    'C:\\ungoogled-chromium-windows\\build', {retentionDays: 1, compressionLevel: 0});
                break;
            } catch (e) {
                console.error(`Upload artifact failed: ${e}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    }
}

run().catch(err => core.setFailed(err.message));
