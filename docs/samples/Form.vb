Public Class Form
    ' The catalog is a region directive: the directive lines are never injected.
    ' #region catalog
    Private Shared ReadOnly CatalogList As String() = {"bolt", "nut", "washer"}
    ' #endregion

    Public Function Add(item As String) As String
        Dim note As String = "a ""}"" decoy"
        Return note
    End Function

    Public Function Dispatch(methodName As String) As Boolean
        If methodName = "count" Then
            Return CatalogList.Length > 0
        End If
        Return False
    End Function

    Public Function Legacy() As Boolean 'count
        Return CatalogList.Length > 0
    End Function
End Class
