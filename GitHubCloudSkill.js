/**
 * Skill: GitHub‑Contents 纯前端云存储Skill
 * @description 直接调用GitHub REST Contents API，图片上传/拉取/删除、元数据云端同步，PAT混淆、localStorage缓存登录配置
 * 适用：单用户纯前端工具，file:// / GitHub Pages部署，无后端
 * ⚠️安全警告：前端PAT无法真正加密，仅限个人自用/演示，禁止面向公网普通用户
 * Source: 随机图片选择器 · 云端同步 · AI菜谱
 */
const GitHubCloudSkill = (function () {
    const FOLDER_CONFIG_FILE = ".folder-config.json";
    const STORAGE_KEY_CFG = "gh_cfg";

    let CFG = {
        user: "",
        repo: "",
        branch: "main",
        path: "images/",
        token: ""
    };

    /** 鉴权请求头 */
    function authH() {
        return {
            Authorization: `token ${CFG.token}`,
            "Content-Type": "application/json"
        };
    }

    /** 将仓库内路径各段做 encode，保留 / */
    function encodeRepoPath(path) {
        return String(path || "")
            .replace(/^\/+|\/+$/g, "")
            .split("/")
            .filter(Boolean)
            .map(seg => {
                try {
                    // 已编码过的段避免二次编码
                    return encodeURIComponent(decodeURIComponent(seg));
                } catch {
                    return encodeURIComponent(seg);
                }
            })
            .join("/");
    }

    /** 基础API地址 */
    function apiUrl(path) {
        return `https://api.github.com/repos/${CFG.user}/${CFG.repo}/contents/${encodeRepoPath(path)}`;
    }

    /** 增加时间戳防缓存 */
    function apiUrlFresh(path) {
        return apiUrl(path) + "?t=" + Date.now();
    }

    /**
     * 简单token混淆构造器，仅防肉眼直读，非加密
     * @param {string} prefix ghp_
     * @param {string} rawSecret token主体字符串
     * @returns {()=>string}
     */
    function buildObscureTokenGetter(prefix, rawSecret) {
        return function () {
            const reversed = rawSecret.split("").reverse().join("");
            const restore = reversed.split("").reverse().join("");
            return prefix + restore;
        };
    }

    /** 从localStorage读取登录配置 */
    function loadConfigFromLocalStorage() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_CFG);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            CFG.user = obj.user ?? "";
            CFG.repo = obj.repo ?? "";
            CFG.branch = obj.branch ?? "main";
            CFG.path = obj.path ?? "images/";
            CFG.token = obj.token ?? "";
            return { ...CFG };
        } catch (e) {
            return null;
        }
    }

    /**
     * 保存配置到本地存储
     * @param {boolean} remember true保存，false清除
     */
    function saveConfigToLocalStorage(remember) {
        if (remember) {
            localStorage.setItem(STORAGE_KEY_CFG, JSON.stringify(CFG));
        } else {
            localStorage.removeItem(STORAGE_KEY_CFG);
        }
    }

    /**
     * 创建.gitkeep占位文件初始化空目录
     * @param {string} user
     * @param {string} repo
     * @param {string} path
     * @param {string} token
     * @param {string} branch
     * @returns {Promise<boolean>}
     */
    async function createPathPlaceholder(user, repo, path, token, branch) {
        const resp = await fetch(`https://api.github.com/repos/${user}/${repo}/contents/${path}.gitkeep`, {
            method: "PUT",
            headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message: "初始化图片路径", content: btoa(""), branch })
        });
        return resp.ok;
    }

    /**
     * 获取文件最新SHA，更新/删除必填
     * @param {string} filename 仓库内完整相对路径
     * @returns {Promise<string|null>}
     */
    async function getFileSha(filename) {
        try {
            const res = await fetch(apiUrlFresh(filename), {
                headers: { ...authH(), Accept: "application/vnd.github+json" },
                cache: "no-store"
            });
            if (res.status === 404) return null;
            if (!res.ok) return null;
            const json = await res.json();
            // 单文件返回对象；若误把目录当文件会返回数组
            if (Array.isArray(json)) return null;
            return json.sha || null;
        } catch (err) {
            return null;
        }
    }

    /**
     * 获取图片目录，过滤图片文件
     * @returns {Promise<Array<{id:string,name:string,url:string,sha:string,source:"GitHub"}>>}
     */
    async function fetchImageList() {
        const res = await fetch(apiUrlFresh(CFG.path), { headers: authH(), cache: "no-store" });
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`fetchImageList http ${res.status}`);
        const files = await res.json();
        const imageExtRe = /\.(png|jpg|jpeg|gif|webp|avif|bmp|ico|svg|tiff?|heic|heif)$/i;
        return files
            .filter(f => f.type === "file" && imageExtRe.test(f.name))
            .map(f => ({
                id: "gh-" + f.sha.slice(0, 8),
                name: f.name,
                url: f.download_url,
                sha: f.sha,
                source: "GitHub"
            }));
    }

    /**
     * 上传base64字符串（已剥离data前缀）
     * @param {string} filePath 仓库内路径
     * @param {string} base64NoPrefix
     * @param {string} message commit信息
     * @param {string|null} sha 旧文件sha，新增传null
     * @returns {Promise<any>}
     */
    async function uploadBase64File(filePath, base64NoPrefix, message, sha = null) {
        const body = { message, content: base64NoPrefix, branch: CFG.branch };
        if (sha) body.sha = sha;
        const resp = await fetch(apiUrl(filePath), {
            method: "PUT",
            headers: {
                ...authH(),
                Accept: "application/vnd.github+json"
            },
            body: JSON.stringify(body)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const msg = data?.message || ("upload fail " + resp.status);
            const err = new Error(msg);
            err.status = resp.status;
            err.github = data;
            throw err;
        }
        return data;
    }

    /**
     * 上传浏览器File图片对象
     * @param {File} file
     * @param {string} saveFilename 仓库保存文件名
     * @returns {Promise<{id:string,name:string,url:string,sha:string,source:"GitHub"}>}
     */
    async function uploadImageFile(file, saveFilename) {
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => {
                const full = /**@type {string}*/(e.target.result);
                resolve(full.split(",")[1]);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        const result = await uploadBase64File(CFG.path + saveFilename, base64, `upload ${saveFilename}`, null);
        const content = result.content;
        return {
            id: "gh-" + content.sha.slice(0, 8),
            name: content.name,
            url: content.download_url,
            sha: content.sha,
            source: "GitHub"
        };
    }

    /**
     * 删除仓库文件
     * @param {string} filePath 仓库内路径
     * @param {string} sha 文件sha
     * @param {string} msg commit信息
     * @returns {Promise<boolean>}
     */
    async function deleteFile(filePath, sha, msg = "delete file") {
        const body = { message: msg, sha: sha, branch: CFG.branch };
        const resp = await fetch(apiUrl(filePath), {
            method: "DELETE",
            headers: authH(),
            body: JSON.stringify(body)
        });
        return resp.ok;
    }

    /**
     * 读取云端元配置 .folder‑config.json
     * @returns {Promise<{folders:Array<{id:string,name:string}>,imgMeta:Record<string,object>}|null>}
     */
    async function loadCloudMeta() {
        const res = await fetch(apiUrlFresh(CFG.path + FOLDER_CONFIG_FILE), { headers: authH(), cache: "no-store" });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`loadCloudMeta http ${res.status}`);
        const json = await res.json();
        const text = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ""))));
        return JSON.parse(text);
    }

    /**
     * 写入元配置到云端
     * @param {{folders:Array<{id:string,name:string}>,imgMeta:Record<string,object>}} metaObj
     * @returns {Promise<void>}
     */
    async function saveCloudMeta(metaObj) {
        let sha = await getFileSha(CFG.path + FOLDER_CONFIG_FILE);
        const jsonStr = JSON.stringify(metaObj, null, 0);
        const base64 = btoa(unescape(encodeURIComponent(jsonStr)));
        await uploadBase64File(CFG.path + FOLDER_CONFIG_FILE, base64, "update folder config", sha);
    }

    /**
     * 登录校验，自动创建占位目录
     * @param {string} user
     * @param {string} repo
     * @param {string} branch
     * @param {string} path 末尾带 /
     * @param {string} token
     * @returns {Promise<{ok:boolean,msg:string}>}
     */
    async function login(user, repo, branch, path, token) {
        CFG.user = user;
        CFG.repo = repo;
        CFG.branch = branch || "main";
        CFG.path = path.replace(/\/?$/, "/");
        CFG.token = token;

        try {
            const res = await fetch(apiUrlFresh(CFG.path), { headers: authH() });
            if (res.status === 401) {
                return { ok: false, msg: "Token无效或缺少repo权限" };
            }
            if (res.status === 404) {
                const ok = await createPathPlaceholder(user, repo, CFG.path, token, CFG.branch);
                if (!ok) return { ok: false, msg: "路径不存在，自动创建.gitkeep失败，请手动建立目录" };
            } else if (!res.ok) {
                return { ok: false, msg: `仓库连接失败 status:${res.status}` };
            }
            return { ok: true, msg: "success" };
        } catch (e) {
            return { ok: false, msg: String(e) };
        }
    }

    /** 登出清空内存配置与本地存储 */
    function logout() {
        CFG = { user: "", repo: "", branch: "main", path: "images/", token: "" };
        localStorage.removeItem(STORAGE_KEY_CFG);
    }

    return {
        CFG,
        authH,
        apiUrl,
        apiUrlFresh,
        buildObscureTokenGetter,
        loadConfigFromLocalStorage,
        saveConfigToLocalStorage,
        createPathPlaceholder,
        getFileSha,
        fetchImageList,
        uploadImageFile,
        uploadBase64File,
        deleteFile,
        loadCloudMeta,
        saveCloudMeta,
        login,
        logout,
        CONST: {
            FOLDER_CONFIG_FILE,
            STORAGE_KEY_CFG
        }
    };
})();

// ESModule导出，浏览器script标签引入注释掉本行
