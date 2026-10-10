const fs = require('node:fs');
const vscode = require('vscode');

exports.activate = async () => {
	try {
		await require('./test.cjs').run();
	} catch (error) {
		fs.writeFileSync(`${process.env.DEBIAN_CHECK_REPORT}.failure.json`, JSON.stringify({ message: String(error) }));
		console.error(error);
	} finally {
		await vscode.commands.executeCommand('workbench.action.quit');
	}
};