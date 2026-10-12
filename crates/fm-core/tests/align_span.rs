//! `align_span` 的取整规则：面板要求刷屏窗口对齐时，多扩出来的部分必须落在画布内。

use fm_core::commands::align_span;

#[test]
fn align_1_is_a_no_op() {
    // C6 的路径：一个字节都不能变
    assert_eq!(align_span(0, 0, 320, 1), (0, 0));
    assert_eq!(align_span(3, 7, 320, 1), (3, 7));
    assert_eq!(align_span(319, 1, 320, 1), (319, 1));
}

#[test]
fn zero_width_stays_empty() {
    // 空 bbox 不该被扩成 4 像素
    assert_eq!(align_span(5, 0, 480, 4), (5, 0));
}

#[test]
fn expands_to_align_boundaries() {
    assert_eq!(align_span(5, 3, 480, 4), (4, 4));
    assert_eq!(align_span(1, 1, 480, 4), (0, 4));
    assert_eq!(align_span(4, 4, 480, 4), (4, 4));
    assert_eq!(align_span(0, 1, 480, 4), (0, 4));
    assert_eq!(align_span(7, 1, 480, 4), (4, 4));
}

#[test]
fn clamps_at_the_right_edge() {
    assert_eq!(align_span(476, 4, 480, 4), (476, 4));
    assert_eq!(align_span(478, 2, 480, 4), (476, 4));
    assert_eq!(align_span(479, 1, 480, 4), (476, 4));
}

#[test]
fn always_covers_the_requested_span() {
    // 不变量：扩出来的区间一定包含原来那一段，且两个边界都对齐、不越界
    for x in 0..64u16 {
        for w in 1..16u16 {
            let (ax, aw) = align_span(x, w, 480, 4);
            assert!(ax <= x, "left {ax} > {x}");
            assert!(ax + aw >= x + w, "right {} < {}", ax + aw, x + w);
            assert_eq!(ax % 4, 0, "start not aligned for {x}+{w}");
            assert_eq!(aw % 4, 0, "width not aligned for {x}+{w}");
            assert!(ax + aw <= 480);
        }
    }
}
