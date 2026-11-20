//! The Windows side: AppContainer profile, folder permission, pipes, job object, process.

use super::{quote, Sandboxed, CONTAINER};
use std::fs::File;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use windows::core::{HSTRING, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, SetHandleInformation, ERROR_ALREADY_EXISTS, HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAGS, HLOCAL, WAIT_OBJECT_0, WIN32_ERROR};
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
};
use windows::Win32::Security::Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName};
use windows::Win32::Security::{FreeSid, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SUB_CONTAINERS_AND_OBJECTS_INHERIT};
use windows::Win32::Storage::FileSystem::{FILE_GENERIC_EXECUTE, FILE_GENERIC_READ};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute, WaitForSingleObject, BELOW_NORMAL_PRIORITY_CLASS,
    CREATE_NO_WINDOW, CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

pub struct Handles {
    process: HANDLE,
    job: HANDLE,
}

// Process and job handles may be used from any thread.
unsafe impl Send for Handles {}

impl Handles {
    pub fn process_handle(&self) -> std::os::windows::io::RawHandle {
        self.process.0
    }

    pub fn wait(&mut self) -> Result<u32, String> {
        unsafe {
            if WaitForSingleObject(self.process, INFINITE) != WAIT_OBJECT_0 {
                return Err("waiting for the camera worker failed".into());
            }
            let mut code = 0u32;
            GetExitCodeProcess(self.process, &mut code).map_err(|e| e.message().to_string())?;
            Ok(code)
        }
    }
}

impl Drop for Handles {
    fn drop(&mut self) {
        // Closing the job ends the worker (KILL_ON_JOB_CLOSE), so it never outlives the app.
        unsafe {
            let _ = CloseHandle(self.job);
            let _ = CloseHandle(self.process);
        }
    }
}

pub fn cpu_ms(process: Option<std::os::windows::io::RawHandle>) -> Option<f64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let h = process.map(HANDLE).unwrap_or_else(|| unsafe { GetCurrentProcess() });
    let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).ok()? };
    let ms = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 10_000.0;
    Some(ms(k) + ms(u))
}

/// The container's SID, creating its profile the first time.
fn container_sid() -> Result<PSID, String> {
    unsafe {
        let name = HSTRING::from(CONTAINER);
        match CreateAppContainerProfile(&name, &HSTRING::from("Lock In camera worker"), &HSTRING::from("Runs Lock In's camera models with no network or file access"), None) {
            Ok(sid) => Ok(sid),
            Err(e) if e.code() == ERROR_ALREADY_EXISTS.to_hresult() => {
                DeriveAppContainerSidFromAppContainerName(&name).map_err(|e| format!("couldn't find the sandbox profile: {}", e.message()))
            }
            Err(e) => Err(format!("couldn't create the sandbox profile: {}", e.message())),
        }
    }
}

fn win32(e: WIN32_ERROR, what: &str) -> Result<(), String> {
    if e.0 == 0 {
        Ok(())
    } else {
        Err(format!("{what}: {}", windows::core::Error::from(e.to_hresult()).message()))
    }
}

/// Lets the container read and run what is in `dir` (and everything under it), and nothing else
/// of the person's. Granting what is already granted changes nothing.
fn grant_read(dir: &Path, sid: PSID) -> Result<(), String> {
    unsafe {
        let path = HSTRING::from(dir.as_os_str());
        let mut old: *mut ACL = std::ptr::null_mut();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        win32(GetNamedSecurityInfoW(&path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, None, None, Some(&mut old), None, &mut sd), "reading the app folder's permissions")?;
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE).0,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: TRUSTEE_W { TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP, ptstrName: PWSTR(sid.0 as *mut u16), ..Default::default() },
        };
        let mut new: *mut ACL = std::ptr::null_mut();
        let r = SetEntriesInAclW(Some(&[entry]), Some(old), &mut new);
        let result = win32(r, "preparing the app folder's permissions").and_then(|_| {
            win32(SetNamedSecurityInfoW(&path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, None, None, Some(new), None), "letting the sandbox read the app folder")
        });
        if !new.is_null() {
            LocalFree(Some(HLOCAL(new as _)));
        }
        if !sd.0.is_null() {
            LocalFree(Some(HLOCAL(sd.0)));
        }
        result
    }
}

/// One pipe: (our end, the child's end). The child's end is inheritable, ours isn't.
fn pipe(child_reads: bool) -> Result<(HANDLE, HANDLE), String> {
    unsafe {
        let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, bInheritHandle: true.into(), ..Default::default() };
        let (mut r, mut w) = (HANDLE::default(), HANDLE::default());
        CreatePipe(&mut r, &mut w, Some(&sa), 1 << 20).map_err(|e| format!("couldn't make a pipe: {}", e.message()))?;
        let (ours, theirs) = if child_reads { (w, r) } else { (r, w) };
        SetHandleInformation(ours, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)).map_err(|e| e.message().to_string())?;
        Ok((ours, theirs))
    }
}

/// Starts `exe args` inside the sandbox, after letting the sandbox read `grant` (the folder that
/// holds the exe, its DLLs and models). Runs at below-normal priority so studying always wins.
pub fn spawn(exe: &Path, args: &[&str], grant: &Path) -> Result<Sandboxed, String> {
    let sid = container_sid()?;
    let result = (|| unsafe {
        grant_read(grant, sid)?;

        let (in_ours, in_theirs) = pipe(true)?;
        let (out_ours, out_theirs) = pipe(false)?;
        let (err_ours, err_theirs) = pipe(false)?;
        let theirs = [in_theirs, out_theirs, err_theirs];

        // Two attributes: the AppContainer with no capabilities, and the exact list of handles
        // the child may inherit (only its three pipe ends).
        let mut size = 0usize;
        let _ = InitializeProcThreadAttributeList(None, 2, None, &mut size);
        let mut buf = vec![0u8; size];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buf.as_mut_ptr().cast());
        InitializeProcThreadAttributeList(Some(list), 2, None, &mut size).map_err(|e| e.message().to_string())?;
        let caps = SECURITY_CAPABILITIES { AppContainerSid: sid, Capabilities: std::ptr::null_mut(), CapabilityCount: 0, Reserved: 0 };
        let set = (|| {
            UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, Some(&caps as *const _ as *const _), std::mem::size_of::<SECURITY_CAPABILITIES>(), None, None)?;
            UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, Some(theirs.as_ptr().cast()), std::mem::size_of_val(&theirs), None, None)
        })();
        if let Err(e) = set {
            DeleteProcThreadAttributeList(list);
            return Err(format!("couldn't set up the sandbox: {}", e.message()));
        }

        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = in_theirs;
        si.StartupInfo.hStdOutput = out_theirs;
        si.StartupInfo.hStdError = err_theirs;
        si.lpAttributeList = list;

        let mut cmd: Vec<u16> = std::iter::once(quote(&exe.to_string_lossy())).chain(args.iter().map(|a| quote(a))).collect::<Vec<_>>().join(" ").encode_utf16().chain([0]).collect();
        let dir = HSTRING::from(grant.as_os_str());
        let mut pi = PROCESS_INFORMATION::default();
        let created = CreateProcessW(
            &HSTRING::from(exe.as_os_str()),
            Some(PWSTR(cmd.as_mut_ptr())),
            None,
            None,
            true,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED | BELOW_NORMAL_PRIORITY_CLASS,
            None,
            &dir,
            &si.StartupInfo,
            &mut pi,
        );
        DeleteProcThreadAttributeList(list);
        for h in theirs {
            let _ = CloseHandle(h);
        }
        if let Err(e) = created {
            for h in [in_ours, out_ours, err_ours] {
                let _ = CloseHandle(h);
            }
            return Err(format!("couldn't start the camera worker in its sandbox: {}", e.message()));
        }

        // The job ends the worker if the app quits or crashes, and stops error dialogs.
        let job = CreateJobObjectW(None, None).map_err(|e| e.message().to_string())?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        let _ = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32);
        let _ = AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);
        let _ = CloseHandle(pi.hThread);

        Ok(Sandboxed {
            stdin: Some(File::from_raw_handle(in_ours.0)),
            stdout: Some(File::from_raw_handle(out_ours.0)),
            stderr: Some(File::from_raw_handle(err_ours.0)),
            inner: Handles { process: pi.hProcess, job },
        })
    })();
    unsafe {
        FreeSid(sid);
    }
    result
}
