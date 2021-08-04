import EventEmitter = require('events');
import * as os from 'os';
import { basename } from 'path';
import * as vscode from 'vscode';
import { ResettableTimeout, TerminalInputMode } from '../common';

const ESC = '\x1b';              // ASCII escape character
const CSI = ESC + '[';      // control sequence introducer
// const BOLD = CSI + '1m';
// const RESET = CSI + '0m';

const KEYS = {
    enter       : '\r',
    del         : '\x7f',
    bs          : '\x08'
};

const controlChars = {};
const zero = '@'.charCodeAt(0);
for (let ix = zero; ix <= 'Z'.charCodeAt(0); ix++) {
    controlChars[String.fromCharCode(ix)] = ix - zero;
}

class ACTIONS {
    static cursorUp(n=1)       { return CSI + n.toString() + 'A'; }
    static cursorDown(n=1)     { return CSI + n.toString() + 'B'; }
    static cursorForward(n=1)  { return CSI + n.toString() + 'C'; }
    static cursorBack(n=1)     { return CSI + n.toString() + 'D'; }
    static clearAll()          { return CSI + '2J' + CSI + '3J' + CSI + ';H'; }  // Kill entire buffer and set cursor postion to 1,1
    static deleteChar()        { return CSI + 'P'; }
    static deletePrevChar()    { return ACTIONS.cursorBack() + ACTIONS.deleteChar(); }
    static deleteCurrChar()    { return ACTIONS.deleteChar(); }
    static killLineForward()   { return CSI + 'K'; }
    static killLine(n=0)       { return (n ? ACTIONS.cursorBack(n) : '') + ACTIONS.killLineForward(); }
};

export interface IMyPtyTerminalOptions {
    name: string;       // Name of the terminal
    prompt: string;     // Prompt to be used
    inputMode: TerminalInputMode
}

/*
** The following events generated by this class
**
** emit('data', String)     -- user input data (value depends on inputmode)
** emit('close')            -- User killed the terminal. Terminal is not usable anymore
** emit('break')            -- User pressed Ctrl-C. COOKED mode only
** emit('eof')              -- User pressed Ctrl-D (POSIX) or Ctrl-Z (Windows) -- COOKED mode only
**
** 'eof' and 'break' does not mean any action was taken. It means the user presed those keys
** and it is upto the client to react.
**
** No event is generated when dispose() is called
*/
export class MyPtyTerminal extends EventEmitter {
    protected writeEmitter = new vscode.EventEmitter<string>() ;
    private didPrompt = false;
    private curLine = '';           // This input entered by the user
    private cursorPos = 1;          // This a relative position ater any prompt or output text
    public terminal: vscode.Terminal = null;
    private disposing = false;
    private isPaused = false;
    protected promptTimer: ResettableTimeout = null;

    readonly pty: vscode.Pseudoterminal = {
        onDidWrite: this.writeEmitter.event,
        // onDidOverrideDimensions?: vscode.Event<vscode.TerminalDimensions>;
        // onDidClose?: vscode.Event<number | void>;
        open: () => this.doPrompt(),
        close: () => {},
        /*
        open(initialDimensions: vscode.TerminalDimensions): void {
            throw new Error('Method not implemented.');
        }
        close(): void {
            throw new Error('Method not implemented.');
        }
        */
        handleInput: (data:string) => { this.handleInput(data); }
        /*
        setDimensions?(dimensions: vscode.TerminalDimensions): void {
            throw new Error('Method not implemented.');
        }
        */
    }

    constructor(protected options: IMyPtyTerminalOptions) {
        super();
        this.resetOptions(options);
        this.terminal = vscode.window.createTerminal({
            name: options.name,
            pty: this.pty
        });
        vscode.window.onDidCloseTerminal((t) => {
            if ((t === this.terminal) && !this.disposing) {
                this.terminal = null;
                this.emit('close');
                super.removeAllListeners();
            }
        });
    }

    // pause and resume are used when the terminal should appear to not take any input
    // all further input is lost. Output will still be processed
    public pause() {
        this.isPaused = true;
    }
    public resume() {
        this.isPaused = false;
    }

    public resetOptions(opts: IMyPtyTerminalOptions) {
        if (this.options.name !== opts.name) {
            throw Error('Reset terminal: Terminal name cannot change once created');
        }
        if (this.promptTimer) {
            this.promptTimer.kill();
            this.promptTimer = null;
        }
        this.unPrompt();        // This will clear any old prompt
        this.options = opts;
        this.curLine = '';
        this.cursorPos = 1;
        this.write('\n');       // This will write also prompt
    }

    protected handleInput(chr: string): void {
        if (this.isPaused || (this.options.inputMode === TerminalInputMode.DISABLED)) {
            return;
        }
        try {
            switch (chr) {
                case KEYS.enter:
                    this.handleReturn(chr);
                    break;
                case KEYS.del:
                    if (this.options.inputMode === TerminalInputMode.COOKED) {
                        this.killPrevChar();
                    } else {
                        this.emit('data', chr);
                    }
                    break;
                default:
                    if (!this.handleSpecialChar(chr) && (chr.length === 1)) {
                        // Handle special chars and leave the rest. If the char.length is not 1
                        // it is something special
                        this.curLine = MyPtyTerminal.insertCharsAt(this.curLine, chr, this.cursorPos-1);
                        this.writeEmitter.fire(ACTIONS.killLineForward());
                        const tail = this.curLine.slice(this.cursorPos-1);
                        this.writeEmitter.fire(tail);
                        if (tail.length > 1) {
                            this.writeEmitter.fire(ACTIONS.cursorBack(tail.length-1));
                        }
                        this.cursorPos += chr.length;
                    }
                    break
            }
        }
        catch (e) {
            console.error(`MyPtyTerminal: handleInput: ${e}`);
        }
    }
    
    private handleReturn(chr: string) {
        if (this.options.inputMode === TerminalInputMode.COOKED) {
            this.emit('data', this.curLine + os.EOL);
            this.curLine = '';
            this.cursorPos = 1;
            this.write('\r\n');
        } else {
            this.emit('data', chr);
            if (this.options.inputMode === TerminalInputMode.RAWECHO) {
                this.write('\r\n');
            }
        }
    }

    protected handleSpecialChar(chr: string): boolean {
        if (this.options.inputMode !== TerminalInputMode.COOKED){
            if (this.options.inputMode === TerminalInputMode.RAWECHO) {
                this.writeEmitter.fire(chr);
            }
            this.emit('data', chr);
            return true;
        }
        let code = chr.charCodeAt(0);
        if (code === 27) {      // Esc character
            if ((chr[1] !== '[') || (chr.length !== 3)) {
                return true;
            }
            switch (chr[2]) {
                case 'A': { // UP: TODO: use for history
                    break;
                }
                case 'B': { // DOWN: TODO: use for history
                    break;
                }
                case 'C': { // RIGHT
                    this.moveRight();
                    break;
                }
                case 'D': { // LEFT
                    this.moveLeft();
                    break;
                }
            }
            return true;
        } else if ((chr.length === 1) && (code < 0x20)) {
            chr = String.fromCharCode(code += 0x40);
            switch (chr) {
                case 'C': {
                    this.emit('break');
                    break;
                }
                case 'D': {
                    if (os.platform() !== 'win32') {
                        this.emit('eof');
                    }
                    break;
                }
                case 'Z': {
                    if (os.platform() === 'win32') {
                        this.emit('eof');
                    }
                    break;
                }
                case 'A': { // move cursor to beginning of line
                    this.moveToBeg();
                    break;
                }
                case 'E': { // move cursor to end of line
                    this.moveToEnd();
                    break;
                }
                case 'F': { // move cursor forward
                    this.moveRight();
                    break;
                }
                case 'B': { // move cursor back
                    this.moveLeft();
                    break;
                }
                case 'D': { // kill char at cursor
                    this.killCurrChar();
                    break;
                }
                case 'H': { // kill char left of cursor
                    this.killPrevChar();
                    break;
                }
                case 'K': { // Kill from current cursor (inclusive) to end of line
                    this.killLineFromCursor();
                    break;
                }
                case 'U': { // Kill entire line
                    this.killEntireLine();
                    break;
                }
            }
            return true;
        } else {
            return false;
        }     
    }

    private killEntireLine() {
        const n = this.cursorPos - 1;
        if (n > 0) {
            this.writeEmitter.fire(ACTIONS.killLine(n));
            this.cursorPos = 1;
            this.curLine = '';
        }
    }

    private killLineFromCursor() {
        const n = this.curLine.length - this.cursorPos + 1;
        if (n > 1) {
            this.writeEmitter.fire(ACTIONS.killLineForward());
            this.curLine = this.curLine.slice(this.cursorPos - 1, n);
        }
    }

    private killCurrChar() {
        if (this.cursorPos <= this.curLine.length) {
            this.writeEmitter.fire(ACTIONS.deleteCurrChar());
            this.curLine = MyPtyTerminal.removeCharAt(this.curLine, this.cursorPos - 1);
        }
    }

    private moveToEnd() {
        const n = this.curLine.length - this.cursorPos + 1;
        if (n > 0) {
            this.writeEmitter.fire(ACTIONS.cursorForward(n));
            this.cursorPos += n;
        }
    }

    private moveToBeg() {
        const n = this.cursorPos - 1;
        if (n > 0) {
            this.writeEmitter.fire(ACTIONS.cursorBack(n));
            this.cursorPos = 1;
        }
    }

    private moveLeft() {
        if (this.cursorPos > 1) {
            this.writeEmitter.fire(ACTIONS.cursorBack(1));
            this.cursorPos--;
        }
    }

    private moveRight() {
        if (this.cursorPos <= this.curLine.length) {
            this.writeEmitter.fire(ACTIONS.cursorForward(1));
            this.cursorPos++;
        }
    }

    private killPrevChar() {
        if (this.cursorPos > 1) {
            this.writeEmitter.fire(ACTIONS.deletePrevChar());
            this.cursorPos--;
            this.curLine = MyPtyTerminal.removeCharAt(this.curLine, this.cursorPos - 1);
        }
    }

    static removeCharAt(str: string, ix:number): string {
        if (ix === 0) {
            return str.slice(1);
        } else if (ix >= (str.length - 1)) {
            return str.slice(0,-1);
        } else {
            return str.slice(0, ix) + str.slice(ix+1);
        }
    }

    static insertCharsAt(str: string, chr: string, ix:number): string {
        if (ix === 0) {
            return chr + str;
        } else if (ix >= (str.length - 1)) {
            return str + chr;
        } else {
            return str.slice(0, ix) + chr + str.slice(ix);
        }
    }

    public clearTerminalBuffer() {
        this.writeEmitter.fire(ACTIONS.clearAll());
        this.curLine = '';
        this.cursorPos = 1;
    }

    public write(data: string | Buffer) {
        try {
            this.unPrompt();
            let str = data.toString('utf8');
            const endsWithNl = str.endsWith('\n');
            str = str.replace(/[\r]?\n/g, '\r\n');
            this.writeEmitter.fire(str);
            if (str.endsWith('\n')) {
                this.doPrompt();
            } else if (this.promptTimer) {
                this.promptTimer.kill();
            }
        }
        catch (e) {
            console.error(`MyPtyTerminal: write: ${e}`);
        }
    }

    // When we prompt, we not only write the prompt but also any remaining input
    protected doPrompt() {
        if (!this.didPrompt) {
            if (this.promptTimer === null) {
                this.promptTimer = new ResettableTimeout(() => {
                const str = this.options.prompt + this.curLine;
                if (str.length) {
                    this.writeEmitter.fire(str);
                }
                this.didPrompt = true;
                }, 100);
            } else {
                this.promptTimer.reset();
            }
        }
    }

    // When we unPrompt, we not only erase the prompt but any remaining input
    protected unPrompt() {
        if (this.didPrompt) {
            const len = this.options.prompt.length + this.curLine.length;
            this.writeEmitter.fire(ACTIONS.killLine(len));
            this.didPrompt = false;
        }
    }

    public dispose() {
        if (this.terminal) {
            super.removeAllListeners();
            this.disposing = true;
            this.terminal.dispose();
            this.terminal = null;
        }
        if (this.promptTimer) {
            this.promptTimer.kill();
            this.promptTimer = null;
        }
    }
}
