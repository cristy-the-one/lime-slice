//! COM handler. Built on Windows only. Every entry point catches a panic.

use std::ffi::c_void;
use std::sync::Mutex;

use lime_preview::{preview, Preview, Summary};
use windows::{
    core::{implement, IUnknown, Interface, Ref, Result, BOOL, GUID, HRESULT, PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, COLORREF, E_FAIL, E_INVALIDARG,
            HMODULE, HWND, LPARAM, RECT, STG_E_ACCESSDENIED, S_FALSE, S_OK, WIN32_ERROR, WPARAM,
        },
        Graphics::{
            Gdi::{
                CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, DrawTextW, GetDC,
                GetDIBits, ReleaseDC, SelectObject, SetBkColor, SetTextColor, BITMAPINFO,
                BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, DT_CENTER, DT_END_ELLIPSIS, DT_NOPREFIX,
                DT_WORDBREAK, HBITMAP, HGDIOBJ,
            },
            Imaging::{
                CLSID_WICImagingFactory, GUID_WICPixelFormat32bppPBGRA, IWICBitmapSource,
                IWICImagingFactory, WICBitmapDitherTypeNone, WICBitmapInterpolationModeFant,
                WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
            },
        },
        Storage::EnhancedStorage::{
            PKEY_ApplicationName, PKEY_Comment, PKEY_Keywords, PKEY_Subject, PKEY_Title,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoUninitialize, IClassFactory,
                IClassFactory_Impl, IStream, StructuredStorage::PROPVARIANT, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED, STGM_READ,
            },
            LibraryLoader::{
                GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            },
            Registry::{
                RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY,
                HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
            },
            Variant::VT_LPWSTR,
        },
        UI::{
            Shell::{
                IPreviewHandler, IPreviewHandlerVisuals, IPreviewHandlerVisuals_Impl,
                IPreviewHandler_Impl, IThumbnailProvider, IThumbnailProvider_Impl,
                PropertiesSystem::{
                    IInitializeWithStream, IInitializeWithStream_Impl, IPropertyStore,
                    IPropertyStore_Impl,
                },
                SHCreateMemStream, SHCreateStreamOnFileEx, WTSAT_ARGB, WTS_ALPHATYPE,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, SendMessageW, IMAGE_BITMAP, STM_SETIMAGE,
                WINDOW_STYLE, WS_CHILD, WS_VISIBLE,
            },
        },
    },
};

use crate::keys::{registry_deletes, registry_values};

const CLSID_GUID: GUID = GUID::from_u128(0xA344EC17_8764_5F01_9C73_FFE2DA751916);

struct State {
    preview: Preview,
    hwnd: HWND,
    child: HWND,
    bitmap: HBITMAP,
    rect: RECT,
}

/// `SS_BITMAP` and `SS_CENTERIMAGE`. They live in a feature this crate does not enable.
const SS_BITMAP: WINDOW_STYLE = WINDOW_STYLE(14);
const SS_CENTERIMAGE: WINDOW_STYLE = WINDOW_STYLE(512);

#[implement(
    IThumbnailProvider,
    IInitializeWithStream,
    IPreviewHandler,
    IPreviewHandlerVisuals,
    IPropertyStore
)]
struct Handler {
    state: Mutex<State>,
}

impl Handler {
    fn new() -> Self {
        Self {
            state: Mutex::new(State {
                preview: preview(&[]),
                hwnd: HWND::default(),
                child: HWND::default(),
                bitmap: HBITMAP::default(),
                rect: RECT::default(),
            }),
        }
    }

    fn load(&self, stream: &IStream) -> Result<()> {
        let bytes = read_stream(stream).map_err(|_| E_FAIL)?;
        let parsed = preview(&bytes);
        let mut state = self.state.lock().map_err(|_| E_FAIL)?;
        state.preview = parsed;
        Ok(())
    }
}

fn drop_preview_widgets(state: &mut State) {
    if !state.child.0.is_null() {
        unsafe {
            let _ = DestroyWindow(state.child);
        }
        state.child = HWND::default();
    }
    if !state.bitmap.0.is_null() {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(state.bitmap.0));
        }
        state.bitmap = HBITMAP::default();
    }
}

/// Size the picture to the pane and hand it to a static control. The control
/// does not own the bitmap, so `Unload` deletes it.
fn show_preview(state: &mut State) -> Result<()> {
    if state.hwnd.0.is_null() {
        return Err(E_FAIL.into());
    }
    drop_preview_widgets(state);
    let width = (state.rect.right - state.rect.left).max(1);
    let height = (state.rect.bottom - state.rect.top).max(1);
    let cx = (width as u32).min(height as u32).clamp(32, 512);
    let bmp = bitmap_for(&state.preview, cx)?;
    state.bitmap = bmp;
    let child = unsafe {
        CreateWindowExW(
            Default::default(),
            windows::core::w!("STATIC"),
            PCWSTR::null(),
            WS_CHILD | WS_VISIBLE | SS_BITMAP | SS_CENTERIMAGE,
            state.rect.left,
            state.rect.top,
            width,
            height,
            Some(state.hwnd),
            None,
            None,
            None,
        )
    };
    let child = match child {
        Ok(hwnd) => hwnd,
        Err(err) => {
            drop_preview_widgets(state);
            return Err(err);
        }
    };
    unsafe {
        let _ = SendMessageW(
            child,
            STM_SETIMAGE,
            Some(WPARAM(IMAGE_BITMAP.0 as usize)),
            Some(LPARAM(bmp.0 as isize)),
        );
    }
    state.child = child;
    Ok(())
}

fn guard(body: impl FnOnce() -> Result<()> + std::panic::UnwindSafe) -> Result<()> {
    match std::panic::catch_unwind(body) {
        Ok(result) => result,
        Err(_) => Err(E_FAIL.into()),
    }
}

impl IInitializeWithStream_Impl for Handler_Impl {
    fn Initialize(&self, pstream: Ref<IStream>, _grfmode: u32) -> Result<()> {
        guard(|| self.load(pstream.ok()?))
    }
}

impl IThumbnailProvider_Impl for Handler_Impl {
    fn GetThumbnail(
        &self,
        cx: u32,
        phbmp: *mut HBITMAP,
        pdwalpha: *mut WTS_ALPHATYPE,
    ) -> Result<()> {
        guard(|| {
            if phbmp.is_null() || pdwalpha.is_null() {
                return Err(E_INVALIDARG.into());
            }
            let state = self.state.lock().map_err(|_| E_FAIL)?;
            let bmp = bitmap_for(&state.preview, cx.max(1))?;
            unsafe {
                *phbmp = bmp;
                *pdwalpha = WTSAT_ARGB;
            }
            Ok(())
        })
    }
}

impl IPreviewHandler_Impl for Handler_Impl {
    fn SetWindow(&self, hwnd: HWND, prc: *const RECT) -> Result<()> {
        guard(|| {
            let mut state = self.state.lock().map_err(|_| E_FAIL)?;
            state.hwnd = hwnd;
            if !prc.is_null() {
                state.rect = unsafe { *prc };
            }
            Ok(())
        })
    }

    fn SetRect(&self, prc: *const RECT) -> Result<()> {
        guard(|| {
            if prc.is_null() {
                return Err(E_INVALIDARG.into());
            }
            let mut state = self.state.lock().map_err(|_| E_FAIL)?;
            state.rect = unsafe { *prc };
            if !state.child.0.is_null() {
                show_preview(&mut state)?;
            }
            Ok(())
        })
    }

    fn DoPreview(&self) -> Result<()> {
        guard(|| {
            let mut state = self.state.lock().map_err(|_| E_FAIL)?;
            show_preview(&mut state)
        })
    }

    fn Unload(&self) -> Result<()> {
        guard(|| {
            let mut state = self.state.lock().map_err(|_| E_FAIL)?;
            drop_preview_widgets(&mut state);
            state.preview = preview(&[]);
            Ok(())
        })
    }

    fn SetFocus(&self) -> Result<()> {
        Ok(())
    }

    fn QueryFocus(&self) -> Result<HWND> {
        let state = self.state.lock().map_err(|_| E_FAIL)?;
        Ok(state.child)
    }

    fn TranslateAccelerator(
        &self,
        _pmsg: *const windows::Win32::UI::WindowsAndMessaging::MSG,
    ) -> Result<()> {
        Err(S_FALSE.into())
    }
}

impl IPreviewHandlerVisuals_Impl for Handler_Impl {
    fn SetBackgroundColor(&self, _color: COLORREF) -> Result<()> {
        Ok(())
    }
    fn SetFont(&self, _plf: *const windows::Win32::Graphics::Gdi::LOGFONTW) -> Result<()> {
        Ok(())
    }
    fn SetTextColor(&self, _color: COLORREF) -> Result<()> {
        Ok(())
    }
}

impl IPropertyStore_Impl for Handler_Impl {
    fn GetCount(&self) -> Result<u32> {
        Ok(self.props().len() as u32)
    }

    fn GetAt(&self, iprop: u32, pkey: *mut windows::Win32::Foundation::PROPERTYKEY) -> Result<()> {
        guard(|| {
            let props = self.props();
            let key = props.get(iprop as usize).ok_or(E_INVALIDARG)?;
            if pkey.is_null() {
                return Err(E_INVALIDARG.into());
            }
            unsafe { *pkey = key.0 };
            Ok(())
        })
    }

    fn GetValue(&self, key: *const windows::Win32::Foundation::PROPERTYKEY) -> Result<PROPVARIANT> {
        if key.is_null() {
            return Err(E_INVALIDARG.into());
        }
        let wanted = unsafe { *key };
        let text = self
            .props()
            .into_iter()
            .find(|row| row.0 == wanted)
            .map(|row| row.1);
        let Some(text) = text else {
            return Err(E_INVALIDARG.into());
        };
        Ok(string_variant(&text))
    }

    fn SetValue(
        &self,
        _key: *const windows::Win32::Foundation::PROPERTYKEY,
        _propvar: *const PROPVARIANT,
    ) -> Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }

    fn Commit(&self) -> Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }
}

impl Handler_Impl {
    fn props(&self) -> Vec<(windows::Win32::Foundation::PROPERTYKEY, String)> {
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        props_of(state.preview.summary.as_ref())
    }
}

fn props_of(summary: Option<&Summary>) -> Vec<(windows::Win32::Foundation::PROPERTYKEY, String)> {
    let mut rows = vec![(PKEY_ApplicationName, "Lime Slice".to_string())];
    let Some(summary) = summary else {
        return rows;
    };
    if let Some(name) = summary.name.as_deref() {
        rows.push((PKEY_Title, name.to_string()));
    }
    if let Some(printer) = summary.printer.as_deref() {
        rows.push((PKEY_Subject, printer.to_string()));
        rows.push((PKEY_Keywords, printer.to_string()));
    }
    rows.push((PKEY_Comment, comment_line(summary)));
    rows
}

fn comment_line(summary: &Summary) -> String {
    let mut parts = Vec::new();
    if let Some(count) = summary.object_count {
        parts.push(if count == 1 {
            "1 object".into()
        } else {
            format!("{count} objects")
        });
    }
    if let Some(layer) = summary.layer_height {
        parts.push(format!("{layer:.2} mm"));
    }
    if let Some(printer) = summary.printer.as_deref() {
        parts.push(printer.to_string());
    }
    if let Some(grams) = summary.grams {
        parts.push(format!("{grams:.1} g"));
    }
    if let Some(seconds) = summary.sliced_seconds {
        parts.push(format!("{} min", (seconds / 60.0).round() as u64));
    }
    if parts.is_empty() {
        "Lime Slice project".into()
    } else {
        parts.join(" · ")
    }
}

fn string_variant(text: &str) -> PROPVARIANT {
    let chars = wide(text);
    let ptr = unsafe { CoTaskMemAlloc(chars.len() * 2) as *mut u16 };
    if !ptr.is_null() {
        unsafe { std::ptr::copy_nonoverlapping(chars.as_ptr(), ptr, chars.len()) };
    }
    let mut variant = PROPVARIANT::default();
    unsafe {
        let inner = &mut *variant.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = PWSTR(ptr);
    }
    variant
}

fn bitmap_for(parsed: &Preview, cx: u32) -> Result<HBITMAP> {
    if let Some(png) = parsed.image() {
        if let Some(bmp) = decode_png(png, cx) {
            return Ok(bmp);
        }
    }
    card(parsed.summary.as_ref(), cx)
}

fn decode_png(png: &[u8], cx: u32) -> Option<HBITMAP> {
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let stream = SHCreateMemStream(Some(png))?;
        let decoder = factory
            .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
            .ok()?;
        let frame = decoder.GetFrame(0).ok()?;
        let mut width = 0u32;
        let mut height = 0u32;
        frame.GetSize(&mut width, &mut height).ok()?;
        let long = width.max(height).max(1);
        let (out_w, out_h) = if long > cx {
            let scale = f64::from(cx) / f64::from(long);
            (
                (f64::from(width) * scale).round().max(1.0) as u32,
                (f64::from(height) * scale).round().max(1.0) as u32,
            )
        } else {
            (width, height)
        };
        let source: IWICBitmapSource = if out_w != width || out_h != height {
            let scaler = factory.CreateBitmapScaler().ok()?;
            scaler
                .Initialize(&frame, out_w, out_h, WICBitmapInterpolationModeFant)
                .ok()?;
            scaler.cast().ok()?
        } else {
            frame.cast().ok()?
        };
        let converter = factory.CreateFormatConverter().ok()?;
        converter
            .Initialize(
                &source,
                &GUID_WICPixelFormat32bppPBGRA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .ok()?;
        dib_from_wic(&converter, out_w, out_h)
    }
}

fn dib_from_wic(source: &IWICBitmapSource, width: u32, height: u32) -> Option<HBITMAP> {
    let info = dib_info(width, height);
    let mut bits: *mut c_void = std::ptr::null_mut();
    let dc = unsafe { GetDC(None) };
    let bmp =
        unsafe { CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()? };
    unsafe {
        ReleaseDC(None, dc);
    }
    if bits.is_null() {
        return None;
    }
    let stride = width.saturating_mul(4);
    let size = stride.saturating_mul(height) as usize;
    let pixels = unsafe { std::slice::from_raw_parts_mut(bits as *mut u8, size) };
    unsafe { source.CopyPixels(std::ptr::null(), stride, pixels).ok()? };
    Some(bmp)
}

fn card(summary: Option<&Summary>, cx: u32) -> Result<HBITMAP> {
    let width = cx.max(32);
    let height = cx.max(32);
    let info = dib_info(width, height);
    let mut bits: *mut c_void = std::ptr::null_mut();
    let screen = unsafe { GetDC(None) };
    let bmp = unsafe { CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0)? };
    unsafe {
        ReleaseDC(None, screen);
    }
    if !bits.is_null() {
        let pixels = unsafe {
            std::slice::from_raw_parts_mut(bits as *mut u32, (width as usize) * (height as usize))
        };
        pixels.fill(0xfff4_efe6);
    }
    unsafe {
        let dc = CreateCompatibleDC(None);
        if !dc.0.is_null() {
            let old = SelectObject(dc, HGDIOBJ(bmp.0));
            SetBkColor(dc, COLORREF(0x00e6_eff4));
            SetTextColor(dc, COLORREF(0x0022_2218));
            let empty = Summary {
                name: None,
                printer: None,
                object_count: None,
                layer_height: None,
                sliced_seconds: None,
                grams: None,
            };
            let text = comment_line(summary.unwrap_or(&empty));
            let title = summary
                .and_then(|row| row.name.clone())
                .unwrap_or_else(|| "Lime Slice project".into());
            let line = if text == "Lime Slice project" {
                title
            } else {
                format!("{title}\n{text}")
            };
            let mut wide_line: Vec<u16> = line.encode_utf16().collect();
            let mut rect = RECT {
                left: 8,
                top: 8,
                right: width as i32 - 8,
                bottom: height as i32 - 8,
            };
            DrawTextW(
                dc,
                &mut wide_line,
                &mut rect,
                DT_CENTER | DT_WORDBREAK | DT_NOPREFIX | DT_END_ELLIPSIS,
            );
            SelectObject(dc, old);
            let _ = DeleteDC(dc);
        }
    }
    Ok(bmp)
}

fn dib_info(width: u32, height: u32) -> BITMAPINFO {
    BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    }
}

fn read_stream(stream: &IStream) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let mut read = 0u32;
        let hr = unsafe {
            stream.Read(
                buf.as_mut_ptr() as *mut c_void,
                buf.len() as u32,
                Some(&mut read),
            )
        };
        if hr.is_err() && hr != S_FALSE {
            return Err(std::io::Error::other("stream"));
        }
        if read == 0 {
            break;
        }
        out.extend_from_slice(&buf[..read as usize]);
        if out.len() > 64 * 1024 * 1024 {
            break;
        }
    }
    Ok(out)
}

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Ref<IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut c_void,
    ) -> Result<()> {
        guard(|| {
            if !punkouter.is_null() {
                return Err(CLASS_E_NOAGGREGATION.into());
            }
            if ppvobject.is_null() || riid.is_null() {
                return Err(E_INVALIDARG.into());
            }
            let handler: IUnknown = Handler::new().into();
            unsafe { handler.query(riid, ppvobject).ok() }
        })
    }

    fn LockServer(&self, _flock: BOOL) -> Result<()> {
        Ok(())
    }
}

/// # Safety
/// Called by COM. `ppv` is written only when the class object is returned.
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    catch_hresult(|| {
        if rclsid.is_null() || riid.is_null() || ppv.is_null() {
            return Err(E_INVALIDARG.into());
        }
        if unsafe { *rclsid } != CLSID_GUID {
            return Err(CLASS_E_CLASSNOTAVAILABLE.into());
        }
        let factory: IClassFactory = Factory.into();
        unsafe { factory.query(riid, ppv).ok() }
    })
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_FALSE
}

#[no_mangle]
pub extern "system" fn DllRegisterServer() -> HRESULT {
    catch_hresult(|| write_registration(&module_path().unwrap_or_else(|| "lime_shell.dll".into())))
}

#[no_mangle]
pub extern "system" fn DllUnregisterServer() -> HRESULT {
    catch_hresult(delete_registration)
}

fn catch_hresult(body: impl FnOnce() -> Result<()> + std::panic::UnwindSafe) -> HRESULT {
    match std::panic::catch_unwind(body) {
        Ok(Ok(())) => S_OK,
        Ok(Err(err)) => err.into(),
        Err(_) => E_FAIL,
    }
}

fn module_path() -> Option<String> {
    unsafe {
        let mut module = HMODULE::default();
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR(module_path as *const () as *const u16),
            &mut module,
        )
        .ok()?;
        let mut buf = vec![0u16; 1024];
        let n = GetModuleFileNameW(Some(module), &mut buf);
        if n == 0 {
            return None;
        }
        buf.truncate(n as usize);
        String::from_utf16(&buf).ok()
    }
}

fn write_registration(dll: &str) -> Result<()> {
    for row in registry_values(dll) {
        set_sz(&row.key, &row.name, &row.data)?;
    }
    Ok(())
}

fn delete_registration() -> Result<()> {
    let mut seen = std::collections::BTreeSet::new();
    for key in registry_deletes() {
        if !seen.insert(key.clone()) {
            continue;
        }
        let path = wide(&format!(r"Software\{key}"));
        unsafe {
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()));
        }
    }
    Ok(())
}

fn set_sz(key: &str, name: &str, data: &str) -> Result<()> {
    let path = wide(&format!(r"Software\{key}"));
    let name_wide = wide(name);
    let bytes = wide(data);
    let mut opened = HKEY::default();
    unsafe {
        let created = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path.as_ptr()),
            Some(0),
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut opened,
            None,
        );
        if created != WIN32_ERROR(0) {
            return Err(E_FAIL.into());
        }
        let value = if name.is_empty() {
            PCWSTR::null()
        } else {
            PCWSTR(name_wide.as_ptr())
        };
        let raw = std::slice::from_raw_parts(bytes.as_ptr() as *const u8, bytes.len() * 2);
        let wrote = RegSetValueExW(opened, value, Some(0), REG_SZ, Some(raw));
        let _ = RegCloseKey(opened);
        if wrote != WIN32_ERROR(0) {
            return Err(E_FAIL.into());
        }
    }
    Ok(())
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Draw a thumbnail for the self-test. Not a COM export.
pub fn thumbnail_bitmap(path: &std::path::Path, cx: u32) -> Result<Vec<u8>> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let path_wide = wide(&path.to_string_lossy());
        let stream =
            SHCreateStreamOnFileEx(PCWSTR(path_wide.as_ptr()), STGM_READ.0, 0, false, None)?;
        let handler = Handler::new();
        handler.load(&stream)?;
        let state = handler.state.lock().map_err(|_| E_FAIL)?;
        let bmp = bitmap_for(&state.preview, cx)?;
        let bytes = bitmap_bytes(bmp);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        CoUninitialize();
        bytes
    }
}

fn bitmap_bytes(bmp: HBITMAP) -> Result<Vec<u8>> {
    let mut info = dib_info(0, 0);
    let dc = unsafe { CreateCompatibleDC(None) };
    let got = unsafe { GetDIBits(dc, bmp, 0, 0, None, &mut info, DIB_RGB_COLORS) };
    if got == 0 {
        unsafe {
            let _ = DeleteDC(dc);
        }
        return Err(E_FAIL.into());
    }
    let height = info.bmiHeader.biHeight.unsigned_abs();
    let width = info.bmiHeader.biWidth.unsigned_abs();
    info.bmiHeader.biHeight = height as i32;
    let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
    unsafe {
        GetDIBits(
            dc,
            bmp,
            0,
            height,
            Some(pixels.as_mut_ptr() as *mut c_void),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
    }
    Ok(pixels)
}
